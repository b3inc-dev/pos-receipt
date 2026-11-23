/**
 * 会計前の商品券額面 → 会計後の自動登録（voucherCartEntry.server.ts）
 * 依存（DB・Shopify・注文メタフィールド・売上サマリー）は差し替えて、登録の決まりだけを見る。
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, any>;
let events: Row[] = [];
let orderResponse: any = null;
let voucherApplied: { applied: number | null; orderName: string | null; orderCreatedAt: string | null } | null = null;
let voucherSettings: Record<string, unknown> | null = null;
let settlementConfirmed = false;
const NOW = new Date("2026-11-23T05:00:00Z");
const synced: string[] = [];
const refreshed: string[] = [];

const prismaMock = {
  specialRefundEvent: {
    async findMany({ where }: any) {
      return events.filter(
        (e) => e.shopId === where.shopId && e.eventType === where.eventType && where.sourceOrderId.in.includes(e.sourceOrderId),
      );
    },
    async create({ data }: any) {
      if (events.some((e) => e.id === data.id)) {
        const err: any = new Error("Unique constraint");
        err.code = "P2002";
        throw err;
      }
      const row = { ...data, createdAt: new Date() };
      events.push(row);
      return row;
    },
  },
};
mock.module(new URL("../db.server.ts", import.meta.url).href, { defaultExport: prismaMock });
mock.module(new URL("../lib/shopifyGraphqlThrottle.server.ts", import.meta.url).href, {
  namedExports: { adminGraphqlWithRetry: async () => orderResponse },
});
mock.module(new URL("../utils/shopTimezone.server.ts", import.meta.url).href, {
  namedExports: {
    getShopTimezoneForDaily: async () => "Asia/Tokyo",
    getCalendarDateStringInTimeZone: (d: Date) => d.toISOString().slice(0, 10),
  },
});
mock.module(new URL("../utils/appSettings.server.ts", import.meta.url).href, {
  namedExports: {
    getAppSetting: async () => voucherSettings,
    VOUCHER_SETTINGS_KEY: "voucher_settings",
    DEFAULT_VOUCHER_SETTINGS: { voucherFeatureEnabled: true, voucherManualAdjustmentEnabled: true, voucherCartEntryEnabled: false },
  },
});
mock.module(new URL("./orderAdjustments.server.ts", import.meta.url).href, {
  namedExports: {
    fetchOrderVoucherApplied: async () => voucherApplied,
    syncOrderAdjustmentsMetafield: async (_a: unknown, _s: string, id: string) => {
      synced.push(id);
      return { ok: true };
    },
  },
});
mock.module(new URL("./orderAdjustmentEdit.server.ts", import.meta.url).href, {
  namedExports: {
    refreshDailySummaryForAdjustment: async (_a: unknown, _s: string, loc: string, date: string) => {
      refreshed.push(`${loc}@${date}`);
    },
    isSettlementConfirmedFor: async () => settlementConfirmed,
  },
});

const { registerVoucherFromCartEntry, webhookPayloadHasVoucherCartFace } = await import("./voucherCartEntry.server.ts");
const admin = { graphql: async () => ({ json: async () => ({}) }) };

function orderWith(attrs: { key: string; value: string }[], extra: Row = {}) {
  return {
    data: {
      order: {
        id: "gid://shopify/Order/9001",
        name: "#9001",
        createdAt: "2026-11-23T03:00:00Z",
        cancelledAt: null,
        currencyCode: "JPY",
        customAttributes: attrs,
        retailLocation: { id: "gid://shopify/Location/77" },
        ...extra,
      },
    },
  };
}

beforeEach(() => {
  events = [];
  synced.length = 0;
  refreshed.length = 0;
  voucherSettings = { voucherCartEntryEnabled: true };
  settlementConfirmed = false;
  orderResponse = orderWith([{ key: "_pos_receipt_voucher_face", value: "5000" }]);
  voucherApplied = { applied: 4300, orderName: "#9001", orderCreatedAt: "2026-11-23T03:00:00Z" };
});

test("会計前の額面があれば、後から登録したときと同じ商品券調整を 1 件作る", async () => {
  const r = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW });
  assert.equal(r.status, "created");
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.id, "pos_vc_cart_9001");
  assert.equal(ev.eventType, "voucher_change_adjustment");
  assert.equal(ev.sourceOrderId, "9001", "POS が送る形（数字だけ）にそろえる");
  assert.equal(ev.locationId, "gid://shopify/Location/77");
  assert.equal(ev.voucherFaceValue, 5000);
  assert.equal(ev.voucherAppliedAmount, 4300);
  assert.equal(ev.voucherChangeAmount, 700);
  assert.equal(ev.amount, 700);
  assert.equal(ev.shopifyRefundStatus, "skipped", "Shopify の返金はしない");
  assert.equal(ev.countDate, "2026-11-23", "数える日は注文の日");
  assert.deepEqual(synced, ["9001"], "注文の記録 pos.adjustments を書き直す");
  assert.deepEqual(refreshed, ["gid://shopify/Location/77@2026-11-23"]);
});

test("2 回呼んでも 1 件（会計後の画面と注文更新の知らせが両方来ても）", async () => {
  await registerVoucherFromCartEntry(admin, "shop1", "gid://shopify/Order/9001", { now: NOW });
  const r = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW });
  assert.equal(r.status, "already");
  assert.equal(events.length, 1);
});

test("同時に来て主キーでぶつかったときは、先に作った方を返す", async () => {
  // findFirst では見えず create でぶつかる場合
  events.push({ id: "pos_vc_cart_9001", shopId: "other", eventType: "x", status: "active", sourceOrderId: "z" });
  const findMany = prismaMock.specialRefundEvent.findMany;
  let calls = 0;
  (prismaMock.specialRefundEvent as any).findMany = async () => {
    calls += 1;
    return calls === 1 ? [] : [{ id: "pos_vc_cart_9001", status: "active", voucherFaceValue: 5000, voucherAppliedAmount: 4300, voucherChangeAmount: 700, sourceOrderName: "#9001" }];
  };
  try {
    const r = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW });
    assert.equal(r.status, "already");
  } finally {
    (prismaMock.specialRefundEvent as any).findMany = findMany;
  }
});

test("手で登録した商品券調整が先にあれば、自動では作らない", async () => {
  events.push({ id: "manual1", shopId: "shop1", eventType: "voucher_change_adjustment", status: "active", sourceOrderId: "9001", voucherFaceValue: 5000, voucherAppliedAmount: 4300, voucherChangeAmount: 700 });
  const r = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW });
  assert.equal(r.status, "already");
  assert.equal(events.length, 1);
});

test("額面が無い注文・商品券の支払いが無い注文・キャンセル・機能オフでは作らない", async () => {
  orderResponse = orderWith([]);
  assert.equal((await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW })).status, "no_face");

  orderResponse = orderWith([{ key: "_pos_receipt_voucher_face", value: "5000" }]);
  voucherApplied = { applied: null, orderName: "#9001", orderCreatedAt: null };
  const r = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW });
  assert.equal(r.status, "no_voucher_payment");
  assert.equal((r as any).face, 5000);

  voucherApplied = { applied: 4300, orderName: "#9001", orderCreatedAt: null };
  orderResponse = orderWith([{ key: "_pos_receipt_voucher_face", value: "5000" }], { cancelledAt: "2026-11-23T04:00:00Z" });
  assert.equal((await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW })).status, "cancelled");

  orderResponse = orderWith([{ key: "_pos_receipt_voucher_face", value: "5000" }]);
  voucherSettings = { voucherCartEntryEnabled: true, voucherManualAdjustmentEnabled: false };
  assert.equal((await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW })).status, "disabled");

  orderResponse = { errors: [{ message: "x" }] };
  assert.equal((await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW })).status, "order_unreadable");
  assert.equal(events.length, 0);
});

test("注文更新の知らせは、額面の項目がある注文だけ拾う", () => {
  assert.equal(webhookPayloadHasVoucherCartFace({ note_attributes: [{ name: "_pos_receipt_voucher_face", value: "3000" }] }), true);
  assert.equal(webhookPayloadHasVoucherCartFace({ note_attributes: [{ name: "_pos_receipt_voucher_face", value: "" }] }), false);
  assert.equal(webhookPayloadHasVoucherCartFace({ note_attributes: [] }), false);
  assert.equal(webhookPayloadHasVoucherCartFace({}), false);
  assert.equal(webhookPayloadHasVoucherCartFace(null), false);
});

test("無効にした商品券調整がある注文は、あとの知らせで作り直さない", async () => {
  events.push({ id: "manual1", shopId: "shop1", eventType: "voucher_change_adjustment", status: "voided", sourceOrderId: "9001" });
  const r = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW });
  assert.equal(r.status, "already");
  assert.equal(events.length, 1);
});

test("額面が使った額より小さいときは作らない", async () => {
  orderResponse = orderWith([{ key: "_pos_receipt_voucher_face", value: "500" }]);
  const r = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW });
  assert.equal(r.status, "face_too_small");
  assert.equal(events.length, 0);
});

test("注文の日を過ぎた知らせ・精算が確定した日には作らない", async () => {
  const r1 = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: new Date("2026-11-24T05:00:00Z") });
  assert.equal(r1.status, "too_late");
  settlementConfirmed = true;
  const r2 = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW });
  assert.equal(r2.status, "settlement_confirmed");
  assert.equal(events.length, 0);
});

test("管理画面の「会計の前に額面を入れる」が初めのオフなら作らない", async () => {
  voucherSettings = null;
  const r = await registerVoucherFromCartEntry(admin, "shop1", "9001", { now: NOW });
  assert.equal(r.status, "disabled");
});
