/**
 * 返金処理中（pending）のまま数分たった特殊返金を自動で決める（読むだけ・返金を作らない）。
 * 合成データのみ。DB と Shopify は差し替える。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  autoResolveAfterMs,
  decideAutoResolve,
  isAutoResolveDisabled,
  isStalePendingSpecialRefund,
  AUTO_RESOLVE_FAILED_NOTE_PREFIX,
} from "./specialRefundAutoResolvePure.server";
import {
  buildStalePendingWhere,
  resolveStalePendingSpecialRefundsCore,
  type AutoResolveDb,
  type PendingSpecialRefundRow,
} from "./specialRefundAutoResolveCore.server";
import { refundEventMarker } from "./shopifyRefundExecute.server";

const NOW = new Date("2026-11-23T03:00:00.000Z");
const MIN = 60 * 1000;
const AFTER = 5 * MIN;

function row(over: Partial<PendingSpecialRefundRow> = {}): PendingSpecialRefundRow {
  return {
    id: "pos_sr_aaaaaaaaaaaaaaaa-1",
    shopId: "shop-1",
    sourceOrderId: "gid://shopify/Order/1001",
    sourceOrderName: "#1001",
    locationId: "gid://shopify/Location/200",
    eventType: "cash_refund",
    amount: { toString: () => "1000.00" },
    status: "active",
    shopifyRefundStatus: "pending",
    shopifyRefundId: null,
    createdAt: new Date(NOW.getTime() - 30 * MIN),
    updatedAt: new Date(NOW.getTime() - 10 * MIN),
    ...over,
  };
}

function markerRefund(eventId: string, id = "gid://shopify/Refund/9001", amount = "1000.00") {
  return {
    id,
    note: `${refundEventMarker(eventId)} / 特殊返金 / cash_refund / サイズ違い`,
    createdAt: new Date(NOW.getTime() - 29 * MIN).toISOString(),
    totalRefundedSet: { shopMoney: { amount } },
  };
}

/** prisma.specialRefundEvent の findMany / updateMany をまねる（where の一部だけを解く） */
function fakeDb(rows: PendingSpecialRefundRow[]) {
  const store = rows.map((r) => ({ ...r, shopifyRefundError: null as string | null }));
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const db: AutoResolveDb = {
    async findMany(args) {
      const w = args.where as Record<string, any>;
      return store.filter((r) => {
        if (w.shopId && r.shopId !== w.shopId) return false;
        if (w.status && r.status !== w.status) return false;
        if (w.shopifyRefundStatus && r.shopifyRefundStatus !== w.shopifyRefundStatus) return false;
        if (w.updatedAt?.lte && r.updatedAt.getTime() > w.updatedAt.lte.getTime()) return false;
        if (w.sourceOrderId?.in && !w.sourceOrderId.in.includes(r.sourceOrderId)) return false;
        if (typeof w.sourceOrderId === "string" && r.sourceOrderId !== w.sourceOrderId) return false;
        if (w.shopifyRefundId?.not === null && r.shopifyRefundId == null) return false;
        if (w.id?.startsWith && !r.id.startsWith(w.id.startsWith)) return false;
        if (w.locationId?.in && !w.locationId.in.includes(r.locationId)) return false;
        return true;
      }).map((r) => ({ ...r }));
    },
    async updateMany(args) {
      updates.push(args);
      const w = args.where as Record<string, any>;
      let count = 0;
      for (const r of store) {
        if (r.id !== w.id || r.shopId !== w.shopId) continue;
        if (r.status !== w.status || r.shopifyRefundStatus !== w.shopifyRefundStatus) continue;
        if (r.updatedAt.getTime() !== (w.updatedAt as Date).getTime()) continue;
        Object.assign(r, args.data, { updatedAt: NOW });
        count += 1;
      }
      return { count };
    },
  };
  return { db, store, updates };
}

describe("autoResolveAfterMs / isAutoResolveDisabled", () => {
  it("既定は 5 分。2〜1440 分に収め、読めない値は既定", () => {
    assert.equal(autoResolveAfterMs({}), 5 * MIN);
    assert.equal(autoResolveAfterMs({ SPECIAL_REFUND_AUTO_RESOLVE_AFTER_MINUTES: "10" }), 10 * MIN);
    assert.equal(autoResolveAfterMs({ SPECIAL_REFUND_AUTO_RESOLVE_AFTER_MINUTES: "0" }), 2 * MIN);
    assert.equal(autoResolveAfterMs({ SPECIAL_REFUND_AUTO_RESOLVE_AFTER_MINUTES: "99999" }), 1440 * MIN);
    assert.equal(autoResolveAfterMs({ SPECIAL_REFUND_AUTO_RESOLVE_AFTER_MINUTES: "abc" }), 5 * MIN);
  });
  it("0 / false / off で止まる。未設定は動く", () => {
    assert.equal(isAutoResolveDisabled({}), false);
    assert.equal(isAutoResolveDisabled({ SPECIAL_REFUND_AUTO_RESOLVE: "0" }), true);
    assert.equal(isAutoResolveDisabled({ SPECIAL_REFUND_AUTO_RESOLVE: "false" }), true);
    assert.equal(isAutoResolveDisabled({ SPECIAL_REFUND_AUTO_RESOLVE: "off" }), true);
    assert.equal(isAutoResolveDisabled({ SPECIAL_REFUND_AUTO_RESOLVE: "1" }), false);
  });
});

describe("isStalePendingSpecialRefund", () => {
  it("active・pending で、最後に試してから 5 分以上たったものだけ", () => {
    const now = NOW.getTime();
    assert.equal(isStalePendingSpecialRefund(row(), now, AFTER), true);
    assert.equal(
      isStalePendingSpecialRefund(row({ updatedAt: new Date(now - 4 * MIN) }), now, AFTER),
      false,
      "試している最中かもしれない",
    );
    assert.equal(isStalePendingSpecialRefund(row({ shopifyRefundStatus: "success" }), now, AFTER), false);
    assert.equal(isStalePendingSpecialRefund(row({ shopifyRefundStatus: "failed" }), now, AFTER), false);
    assert.equal(isStalePendingSpecialRefund(row({ status: "voided" }), now, AFTER), false);
  });
});

describe("decideAutoResolve", () => {
  const ev = { id: "pos_sr_aaaaaaaaaaaaaaaa-1", eventType: "cash_refund", amount: "1000", createdAt: NOW };

  it("pos_sr_: 印が合う返金があれば success", () => {
    const d = decideAutoResolve(ev, [markerRefund(ev.id)], new Set(), 5);
    assert.deepEqual(d, { action: "success", refundId: "gid://shopify/Refund/9001", reason: "marker" });
  });

  it("pos_sr_: 印が無ければ failed（金額が同じ別の返金があっても、この登録のものとしない）", () => {
    const d = decideAutoResolve(
      ev,
      [
        {
          id: "gid://shopify/Refund/1",
          note: "手で返金",
          createdAt: NOW.toISOString(),
          totalRefundedSet: { shopMoney: { amount: "1000" } },
        },
        markerRefund("pos_sr_bbbbbbbbbbbbbbbb-2", "gid://shopify/Refund/2"),
      ],
      new Set(),
      5,
    );
    assert.equal(d.action, "failed");
    assert.ok(d.action === "failed" && d.error.startsWith(AUTO_RESOLVE_FAILED_NOTE_PREFIX));
    assert.ok(d.action === "failed" && d.error.includes("5 分"));
  });

  it("前からの登録: 「特殊返金」のノート・種別・金額が合う返金がちょうど 1 件なら success", () => {
    const legacy = { ...ev, id: "clxlegacy0001" };
    const d = decideAutoResolve(
      legacy,
      [
        {
          id: "gid://shopify/Refund/7",
          note: "POS Receipt 特殊返金 / cash_refund / サイズ違い",
          createdAt: NOW.toISOString(),
          totalRefundedSet: { shopMoney: { amount: "1000.00" } },
        },
      ],
      new Set(),
      5,
    );
    assert.deepEqual(d, { action: "success", refundId: "gid://shopify/Refund/7", reason: "note_match" });
  });

  it("前からの登録: 返金が見つからない・迷うときは決めない（店の人が選ぶ）", () => {
    const legacy = { ...ev, id: "clxlegacy0001" };
    assert.deepEqual(decideAutoResolve(legacy, [], new Set(), 5), {
      action: "leave",
      reason: "legacy_needs_staff",
    });
    const two = [1, 2].map((n) => ({
      id: `gid://shopify/Refund/${n}`,
      note: "POS Receipt 特殊返金 / cash_refund",
      createdAt: NOW.toISOString(),
      totalRefundedSet: { shopMoney: { amount: "1000" } },
    }));
    assert.equal(decideAutoResolve(legacy, two, new Set(), 5).action, "leave");
  });

  it("前からの登録: ほかの登録に紐づいた返金は使わない", () => {
    const legacy = { ...ev, id: "clxlegacy0001" };
    const refund = {
      id: "gid://shopify/Refund/7",
      note: "POS Receipt 特殊返金 / cash_refund",
      createdAt: NOW.toISOString(),
      totalRefundedSet: { shopMoney: { amount: "1000" } },
    };
    assert.equal(
      decideAutoResolve(legacy, [refund], new Set(["gid://shopify/Refund/7"]), 5).action,
      "leave",
    );
  });
});

describe("buildStalePendingWhere", () => {
  it("active・pending・updatedAt <= 境目に絞り、範囲を足す", () => {
    const cutoff = new Date(NOW.getTime() - AFTER);
    const w = buildStalePendingWhere("shop-1", cutoff, {
      locationIds: ["gid://shopify/Location/200", "200", "200"],
      createdFrom: new Date("2026-11-22T15:00:00Z"),
      createdTo: new Date("2026-11-23T14:59:59Z"),
      onlyKeyedEvents: true,
    }) as Record<string, any>;
    assert.equal(w.shopId, "shop-1");
    assert.equal(w.status, "active");
    assert.equal(w.shopifyRefundStatus, "pending");
    assert.equal(w.updatedAt.lte, cutoff);
    assert.deepEqual(w.locationId.in, ["gid://shopify/Location/200", "200"]);
    assert.ok(w.createdAt.gte && w.createdAt.lte);
    assert.deepEqual(w.id, { startsWith: "pos_sr_" });
  });
});

describe("resolveStalePendingSpecialRefundsCore", () => {
  it("印のある返金 → success。Shopify は読むだけ（返金を作る mutation を一度も送らない）", async () => {
    const { db, store } = fakeDb([row()]);
    const reads: string[] = [];
    const result = await resolveStalePendingSpecialRefundsCore(
      {
        db,
        now: () => NOW,
        readOrderRefunds: async (gid) => {
          reads.push(gid);
          return [markerRefund(row().id)];
        },
      },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    assert.deepEqual(reads, ["gid://shopify/Order/1001"]);
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].status, "success");
    assert.equal(store[0].shopifyRefundStatus, "success");
    assert.equal(store[0].shopifyRefundId, "gid://shopify/Refund/9001");
    // 本体の中で refundCreate を組み立てていないこと（読む query だけ）
    const src = readFileSync(new URL("./specialRefundAutoResolveCore.server.ts", import.meta.url), "utf8");
    assert.ok(!/refundCreate|mutation/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  });

  it("印のある返金が無い → failed（理由つき）", async () => {
    const { db, store } = fakeDb([row()]);
    const result = await resolveStalePendingSpecialRefundsCore(
      { db, now: () => NOW, readOrderRefunds: async () => [] },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    assert.equal(result.resolved[0].status, "failed");
    assert.equal(store[0].shopifyRefundStatus, "failed");
    assert.ok(String(store[0].shopifyRefundError).startsWith(AUTO_RESOLVE_FAILED_NOTE_PREFIX));
  });

  it("5 分たっていないものは読まない・書かない", async () => {
    const { db, updates } = fakeDb([row({ updatedAt: new Date(NOW.getTime() - 2 * MIN) })]);
    let reads = 0;
    const result = await resolveStalePendingSpecialRefundsCore(
      { db, now: () => NOW, readOrderRefunds: async () => (reads++, []) },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    assert.equal(reads, 0);
    assert.equal(updates.length, 0);
    assert.equal(result.checked, 0);
  });

  it("Shopify を読めなかった注文は pending のまま（failed にしない）", async () => {
    const { db, store, updates } = fakeDb([row()]);
    const result = await resolveStalePendingSpecialRefundsCore(
      { db, now: () => NOW, readOrderRefunds: async () => null },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    assert.deepEqual(result.readFailedOrders, ["gid://shopify/Order/1001"]);
    assert.equal(updates.length, 0);
    assert.equal(store[0].shopifyRefundStatus, "pending");

    const thrown = await resolveStalePendingSpecialRefundsCore(
      {
        db,
        now: () => NOW,
        readOrderRefunds: async () => {
          throw new Error("network");
        },
      },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    assert.equal(thrown.readFailedOrders.length, 1);
    assert.equal(store[0].shopifyRefundStatus, "pending");
  });

  it("読み直しの最中に POS の送り直しが pending に書き直したら（updatedAt が変わる）、何も書かない", async () => {
    const { db, store } = fakeDb([row()]);
    const result = await resolveStalePendingSpecialRefundsCore(
      {
        db,
        now: () => NOW,
        readOrderRefunds: async () => {
          // 送り直しが pending に書き直し、同じキーで Shopify に返金を作りにいっている最中
          store[0].updatedAt = new Date(NOW.getTime() - 1000);
          return [];
        },
      },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    assert.equal(result.resolved.length, 0);
    assert.deepEqual(result.skippedConcurrent, [row().id]);
    assert.equal(store[0].shopifyRefundStatus, "pending", "送り直しの結果を上書きしない");
  });

  it("2 回走っても 1 回しか決めない（冪等）。決めたあとは読みもしない", async () => {
    const { db, store } = fakeDb([row()]);
    let reads = 0;
    const deps = {
      db,
      now: () => NOW,
      readOrderRefunds: async () => {
        reads++;
        return [markerRefund(row().id)];
      },
    };
    const first = await resolveStalePendingSpecialRefundsCore(deps, "shop-1", {}, { afterMs: AFTER });
    const second = await resolveStalePendingSpecialRefundsCore(deps, "shop-1", {}, { afterMs: AFTER });
    assert.equal(first.resolved.length, 1);
    assert.equal(second.resolved.length, 0);
    assert.equal(second.checked, 0);
    assert.equal(reads, 1);
    assert.equal(store[0].shopifyRefundStatus, "success");
  });

  it("同時に 2 つ走っても、書き換えは 1 回だけ（楽観ロック）", async () => {
    const { db, store, updates } = fakeDb([row()]);
    const deps = { db, now: () => NOW, readOrderRefunds: async () => [markerRefund(row().id)] };
    const [a, b] = await Promise.all([
      resolveStalePendingSpecialRefundsCore(deps, "shop-1", {}, { afterMs: AFTER }),
      resolveStalePendingSpecialRefundsCore(deps, "shop-1", {}, { afterMs: AFTER }),
    ]);
    assert.equal(a.resolved.length + b.resolved.length, 1);
    assert.equal(a.skippedConcurrent.length + b.skippedConcurrent.length, 1);
    assert.equal(updates.length, 2);
    assert.equal(store[0].shopifyRefundStatus, "success");
  });

  it("注文ごとに 1 回だけ読む。同じ注文の 2 件は、それぞれの印の返金に紐づく", async () => {
    const e1 = row({ id: "pos_sr_aaaaaaaaaaaaaaaa-1", createdAt: new Date(NOW.getTime() - 40 * MIN) });
    const e2 = row({ id: "pos_sr_aaaaaaaaaaaaaaaa-2", createdAt: new Date(NOW.getTime() - 20 * MIN) });
    const { db, store } = fakeDb([e1, e2]);
    let reads = 0;
    const result = await resolveStalePendingSpecialRefundsCore(
      {
        db,
        now: () => NOW,
        readOrderRefunds: async () => {
          reads++;
          return [markerRefund(e2.id, "gid://shopify/Refund/22")];
        },
      },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    assert.equal(reads, 1);
    assert.equal(result.resolved.length, 2);
    assert.equal(store.find((r) => r.id === e1.id)!.shopifyRefundStatus, "failed");
    assert.equal(store.find((r) => r.id === e2.id)!.shopifyRefundStatus, "success");
    assert.equal(store.find((r) => r.id === e2.id)!.shopifyRefundId, "gid://shopify/Refund/22");
  });

  it("前からの登録 2 件が同じ返金に合いそうなときは、どちらにも紐づけない", async () => {
    const legacyNote = {
      id: "gid://shopify/Refund/7",
      note: "POS Receipt 特殊返金 / cash_refund",
      createdAt: NOW.toISOString(),
      totalRefundedSet: { shopMoney: { amount: "1000" } },
    };
    const l1 = row({ id: "clxlegacy0001", createdAt: new Date(NOW.getTime() - 40 * MIN) });
    const l2 = row({ id: "clxlegacy0002", createdAt: new Date(NOW.getTime() - 35 * MIN) });
    const { db, store } = fakeDb([l1, l2]);
    const result = await resolveStalePendingSpecialRefundsCore(
      { db, now: () => NOW, readOrderRefunds: async () => [legacyNote] },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    // 1 件目は success、2 件目はその返金が紐づいたあとなので候補が無く、店の人へ回る
    assert.equal(store[0].shopifyRefundStatus, "success");
    assert.equal(store[1].shopifyRefundStatus, "pending");
    assert.deepEqual(result.leftForStaff, ["clxlegacy0002"]);
  });

  it("前からの登録で返金が見つからないときは、failed にせず pending のまま", async () => {
    const { db, store, updates } = fakeDb([row({ id: "clxlegacy0001" })]);
    const result = await resolveStalePendingSpecialRefundsCore(
      { db, now: () => NOW, readOrderRefunds: async () => [] },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    assert.deepEqual(result.leftForStaff, ["clxlegacy0001"]);
    assert.equal(updates.length, 0);
    assert.equal(store[0].shopifyRefundStatus, "pending");
  });

  it("見回り（onlyKeyedEvents）は前からの登録を見ない", async () => {
    const { db } = fakeDb([row({ id: "clxlegacy0001" })]);
    let reads = 0;
    const result = await resolveStalePendingSpecialRefundsCore(
      { db, now: () => NOW, readOrderRefunds: async () => (reads++, []) },
      "shop-1",
      { onlyKeyedEvents: true },
      { afterMs: AFTER },
    );
    assert.equal(reads, 0);
    assert.equal(result.checked, 0);
  });

  it("ほかの店の登録は見ない", async () => {
    const { db, store } = fakeDb([row({ shopId: "shop-2" })]);
    const result = await resolveStalePendingSpecialRefundsCore(
      { db, now: () => NOW, readOrderRefunds: async () => [] },
      "shop-1",
      {},
      { afterMs: AFTER },
    );
    assert.equal(result.checked, 0);
    assert.equal(store[0].shopifyRefundStatus, "pending");
  });
});

describe("つなぎ込み", () => {
  it("精算の集計は、注文を読む前に自動の確定を呼ぶ（売上サマリーの作り直しはしない）", () => {
    const src = readFileSync(new URL("./settlementEngine.server.ts", import.meta.url), "utf8");
    const call = src.indexOf("await autoResolveStalePendingSpecialRefunds(");
    const fetch = src.indexOf("const createdRaw   = await fetchAllOrders(");
    assert.ok(call > 0 && fetch > 0 && call < fetch);
    assert.ok(src.slice(call, fetch).includes("refreshDailySummary: false"));
    assert.ok(src.includes("assertNoPendingSpecialRefunds(otherEvents)"), "決められなかったものは今までどおり止める");
  });

  it("POS の一覧は、返す前に自動の確定を呼ぶ", () => {
    const src = readFileSync(new URL("../routes/api.special-refunds.tsx", import.meta.url), "utf8");
    const call = src.indexOf("await autoResolveStalePendingSpecialRefunds(");
    const list = src.indexOf("const items = await prisma.specialRefundEvent.findMany(");
    assert.ok(call > 0 && call < list);
  });

  it("見回りは pg-boss の schedule で 5 分ごと", () => {
    const src = readFileSync(new URL("./specialRefundAutoResolveQueue.server.ts", import.meta.url), "utf8");
    assert.ok(src.includes('"*/5 * * * *"'));
    assert.ok(src.includes("onlyKeyedEvents: true"));
    const queue = readFileSync(new URL("./salesSummaryWebhookQueue.server.ts", import.meta.url), "utf8");
    assert.ok(queue.includes("registerSpecialRefundAutoResolveSweep(boss)"));
  });
});
