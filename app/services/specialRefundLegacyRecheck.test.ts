/**
 * 前からある（ID が pos_sr_ で始まらない）pending の特殊返金を、Shopify の返金を読み直して決める（#11 の見直し P1-3）。
 * あわせて、キー無しの古い POS を受ける移行期間（P1-4）と、POS で confirm() を使わないこと（P1-5）。
 * 合成データのみ。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyRefundsForLegacyRecheck,
  decideLegacyRecheck,
  isLegacySpecialRefundEventId,
  type OrderRefundForRecheck,
} from "./specialRefundLegacyRecheck.server";
import { resolveSpecialRefundIdempotencyKey } from "./specialRefundIdempotency.server";
import {
  canRecheckLegacyShopifyRefund,
  canRecheckShopifyRefund,
} from "../../extensions/common/specialRefundRecheck.js";

const legacyEvent = {
  id: "clx0legacy0000000000000001",
  eventType: "cash_refund",
  amount: "1000",
  createdAt: "2026-10-08T03:00:00.000Z",
};

function refund(
  id: string,
  note: string,
  amount: number,
  createdAt = "2026-10-08T03:00:05Z",
): OrderRefundForRecheck {
  return { id, note, createdAt, totalRefundedSet: { shopMoney: { amount: String(amount) } } };
}

const none = new Set<string>();

describe("isLegacySpecialRefundEventId / POS の出し分け", () => {
  it("pos_sr_ 以外を前からの登録とみる", () => {
    assert.equal(isLegacySpecialRefundEventId(legacyEvent.id), true);
    assert.equal(isLegacySpecialRefundEventId("pos_sr_0123456789abcdef"), false);
    assert.equal(isLegacySpecialRefundEventId(""), false);
  });

  it("前からの pending 登録にも「Shopify 返金を確かめる」が出る（別の道）", () => {
    const ev = { ...legacyEvent, status: "active", shopifyRefundStatus: "pending" };
    assert.equal(canRecheckShopifyRefund(ev), false);
    assert.equal(canRecheckLegacyShopifyRefund(ev), true);
    assert.equal(canRecheckLegacyShopifyRefund({ ...ev, status: "voided" }), false);
    assert.equal(canRecheckLegacyShopifyRefund({ ...ev, shopifyRefundStatus: "success" }), false);
    assert.equal(
      canRecheckLegacyShopifyRefund({ ...ev, id: "pos_sr_0123456789abcdef" }),
      false,
      "pos_sr_ は同じキーで送り直す道",
    );
  });
});

describe("classify + decideLegacyRecheck（Shopify の返金は実行しない）", () => {
  it("main の形のノート・同じ種別・同じ金額の返金が 1 件だけ → success（自動）", () => {
    const c = classifyRefundsForLegacyRecheck(
      legacyEvent,
      [refund("gid://shopify/Refund/1", "POS Receipt 特殊返金 / cash_refund / サイズ違い", 1000)],
      none,
    );
    assert.deepEqual(decideLegacyRecheck(c), {
      action: "success",
      refundId: "gid://shopify/Refund/1",
      reason: "note_match",
    });
  });

  it("この登録の印がある返金 → success（キー無しの古い POS から受けた登録）", () => {
    const c = classifyRefundsForLegacyRecheck(
      legacyEvent,
      [
        refund("gid://shopify/Refund/9", `[POS_RECEIPT_EVENT:${legacyEvent.id}] / 特殊返金 / cash_refund`, 1000),
        refund("gid://shopify/Refund/8", "手で返金", 500),
      ],
      none,
    );
    const d = decideLegacyRecheck(c);
    assert.equal(d.action, "success");
    assert.equal(d.action === "success" && d.refundId, "gid://shopify/Refund/9");
  });

  it("返金が 1 件も無い → 店の人が決める（none_found）。勝手に failed にしない", () => {
    const c = classifyRefundsForLegacyRecheck(legacyEvent, [], none);
    const d = decideLegacyRecheck(c);
    assert.equal(d.action, "needs_decision");
    assert.equal(d.action === "needs_decision" && d.reason, "none_found");
    assert.deepEqual(decideLegacyRecheck(c, { resolution: "no_refund" }), {
      action: "failed_no_refund",
    });
  });

  it("金額が違う・別の返金がある → 決めない（ambiguous）。選んだ返金が候補にあるときだけ success", () => {
    const c = classifyRefundsForLegacyRecheck(
      legacyEvent,
      [refund("gid://shopify/Refund/2", "店長が管理画面で返金", 1000)],
      none,
    );
    const d = decideLegacyRecheck(c);
    assert.equal(d.action, "needs_decision");
    assert.equal(d.action === "needs_decision" && d.reason, "ambiguous");
    assert.equal(
      decideLegacyRecheck(c, { resolution: "link", refundId: "gid://shopify/Refund/2" }).action,
      "success",
    );
    assert.equal(
      decideLegacyRecheck(c, { resolution: "link", refundId: "gid://shopify/Refund/999" }).action,
      "reject",
    );
  });

  it("この登録らしい返金があるのに「返金なし」は受けない（二重に数えない）", () => {
    const c = classifyRefundsForLegacyRecheck(
      legacyEvent,
      [
        refund("gid://shopify/Refund/1", "POS Receipt 特殊返金 / cash_refund", 1000),
        refund("gid://shopify/Refund/3", "POS Receipt 特殊返金 / cash_refund", 1000),
      ],
      none,
    );
    assert.equal(decideLegacyRecheck(c).action, "needs_decision", "2 件あれば自動で決めない");
    assert.equal(decideLegacyRecheck(c, { resolution: "no_refund" }).action, "reject");
  });

  it("ほかの登録に紐づいた返金・ほかの登録の印・登録より前の返金は候補にしない", () => {
    const c = classifyRefundsForLegacyRecheck(
      legacyEvent,
      [
        refund("gid://shopify/Refund/4", "POS Receipt 特殊返金 / cash_refund", 1000),
        refund("gid://shopify/Refund/5", "[POS_RECEIPT_EVENT:other-event] / 特殊返金 / cash_refund", 1000),
        refund("gid://shopify/Refund/6", "POS Receipt 特殊返金 / cash_refund", 1000, "2026-10-07T01:00:00Z"),
      ],
      new Set(["gid://shopify/Refund/4"]),
    );
    assert.equal(c.noteMatches.length + c.otherCandidates.length + c.markerMatches.length, 0);
    assert.equal(decideLegacyRecheck(c, { resolution: "no_refund" }).action, "failed_no_refund");
  });

  it("種別が違う特殊返金のノートは「この登録らしい」に入れない", () => {
    const c = classifyRefundsForLegacyRecheck(
      legacyEvent,
      [refund("gid://shopify/Refund/7", "POS Receipt 特殊返金 / payment_method_override", 1000)],
      none,
    );
    assert.equal(c.noteMatches.length, 0);
    assert.equal(c.otherCandidates.length, 1);
  });
});

describe("resolveSpecialRefundIdempotencyKey（移行期間: キー無しの古い POS も受ける）", () => {
  it("キー無しは missing（400 にしない）・不正は invalid・正しいキーは pos_sr_ の ID", () => {
    assert.deepEqual(resolveSpecialRefundIdempotencyKey(undefined), { kind: "missing" });
    assert.deepEqual(resolveSpecialRefundIdempotencyKey("  "), { kind: "missing" });
    assert.deepEqual(resolveSpecialRefundIdempotencyKey("short"), { kind: "invalid" });
    assert.deepEqual(resolveSpecialRefundIdempotencyKey("0123456789abcdef-key"), {
      kind: "keyed",
      eventId: "pos_sr_0123456789abcdef-key",
    });
  });

  it("API はキー無しで 400 を返さない", () => {
    const src = readFileSync(new URL("../routes/api.special-refunds.tsx", import.meta.url), "utf8");
    assert.equal(src.includes('"idempotencyKey is required"'), false);
    assert.ok(src.includes('keyResolution.kind === "missing"'));
  });
});

describe("POS の拡張で confirm() を使わない", () => {
  it("extensions の src と common に confirm( の呼び出しが無い", () => {
    const roots = [
      new URL("../../extensions/pos-smart-grid/src/", import.meta.url),
      new URL("../../extensions/common/", import.meta.url),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const name of readdirSync(root)) {
        if (!/\.(jsx?|tsx?)$/.test(name)) continue;
        const text = readFileSync(join(root.pathname, name), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        if (/(^|[^\w.])confirm\s*\(/.test(text) || /window\.confirm\s*\(/.test(text)) hits.push(name);
      }
    }
    assert.deepEqual(hits, []);
  });
});
