/**
 * 返金の予約 → 純正の返金ができたら自動で付け替え（refundReservation.server.ts）
 * Shopify・付け替えの作成は差し替え、予約の扱い（当てる・待つ・期限・要確認・二度作らない）を見る。
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, any>;
let reservations: Row[] = [];
let events: Row[] = [];
let lines: Row[] = [];
let today = "2026-11-23";
let createCalls: Row[] = [];
let createFail: { status: number; code: string; message: string } | null = null;
const synced: string[] = [];
let settings: Row = {};
let txFail: string | null = null;

function matchWhere(r: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "in" in (v as Row)) return (v as Row).in.includes(r[k]);
    return r[k] === v;
  });
}

const prismaMock: any = {
  refundReservation: {
    async findMany({ where }: any) {
      return reservations.filter((r) => matchWhere(r, where)).sort((a, b) => a.createdAt - b.createdAt);
    },
    async findFirst({ where }: any) {
      return reservations.find((r) => matchWhere(r, where)) ?? null;
    },
    async count({ where }: any) {
      return reservations.filter((r) => matchWhere(r, where)).length;
    },
    async create({ data }: any) {
      const row = { id: `res${reservations.length + 1}`, createdAt: new Date("2026-11-23T02:00:00Z"), updatedAt: new Date(), appliedRefundId: null, appliedEventIds: null, appliedAt: null, reviewReason: null, cancelledAt: null, ...data };
      reservations.push(row);
      return row;
    },
    async updateMany({ where, data }: any) {
      const hit = reservations.filter((r) => matchWhere(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  },
  specialRefundEvent: {
    async findMany({ where }: any) {
      return events.filter((e) => matchWhere(e, where));
    },
  },
  paymentMethodMaster: {
    async findMany() {
      return [
        { rawGatewayPattern: "cash", displayLabel: "現金" },
        { rawGatewayPattern: "gift", displayLabel: "施設ポイント" },
      ];
    },
  },
  async $transaction(fn: any) {
    if (txFail) {
      const err: any = new Error("tx");
      err.code = txFail;
      throw err;
    }
    return fn(prismaMock);
  },
};
mock.module(new URL("../db.server.ts", import.meta.url).href, { defaultExport: prismaMock });
mock.module(new URL("../utils/appSettings.server.ts", import.meta.url).href, {
  namedExports: {
    getAppSetting: async () => settings,
    SPECIAL_REFUND_SETTINGS_KEY: "special_refund_settings",
    DEFAULT_SPECIAL_REFUND_SETTINGS: {
      requireApprovalForPaymentMethodOverride: false,
      refundReservationEnabled: false,
      enableCashRefund: true,
      enablePaymentMethodOverride: true,
    },
  },
});
mock.module(new URL("../utils/shopTimezone.server.ts", import.meta.url).href, {
  namedExports: {
    getShopTimezoneForDaily: async () => "Asia/Tokyo",
    // 今の時刻は「今日」、返金の時刻はその UTC の日（テスト用）
    getCalendarDateStringInTimeZone: (d: Date) =>
      Math.abs(d.getTime() - Date.now()) < 5000 ? today : d.toISOString().slice(0, 10),
  },
});
mock.module(new URL("./nativeRefundReassign.server.ts", import.meta.url).href, {
  namedExports: {
    fetchNativeRefundLines: async () => lines,
    createNativeRefundReassign: async (_lines: unknown, input: any) => {
      createCalls.push(input);
      if (createFail) return { ok: false, ...createFail };
      if (events.some((e) => e.id === input.data.id)) {
        const err: any = new Error("dup");
        err.code = "P2002";
        throw err;
      }
      const ev = { ...input.data, refundSource: "native", shopifyRefundId: input.refundId, countDate: "2026-11-23" };
      events.push(ev);
      return { ok: true, event: ev };
    },
  },
});
mock.module(new URL("./orderAdjustments.server.ts", import.meta.url).href, {
  namedExports: { syncOrderAdjustmentsMetafield: async (_a: unknown, _s: string, id: string) => synced.push(id) },
});
mock.module(new URL("./orderAdjustmentEdit.server.ts", import.meta.url).href, {
  namedExports: { refreshDailySummaryForAdjustment: async () => {} },
});

const svc = await import("./refundReservation.server.ts");
const admin = { graphql: async () => ({ json: async () => ({}) }) };
const ORDER = "gid://shopify/Order/5001";

beforeEach(() => {
  reservations = [];
  events = [];
  lines = [];
  today = "2026-11-23";
  createCalls = [];
  createFail = null;
  synced.length = 0;
  settings = { refundReservationEnabled: true };
  txFail = null;
});

async function reserve(rows: Row[], expectedAmount = 2500) {
  const r = await svc.createRefundReservation(admin, "shop1", { sourceOrderId: ORDER, sourceOrderName: "#5001", locationId: "gid://shopify/Location/1", rows, expectedAmount });
  assert.equal(r.ok, true);
  return r.ok ? r.reservation : null;
}

test("予約 → 返金ができる前は待つ → 返金ができたら付け替えを作る（分割・最後は残り）", async () => {
  await reserve([
    { actualRefundMethod: "cash", eventType: "cash_refund", amount: 1000 },
    { actualRefundMethod: "gift", eventType: "payment_method_override" },
  ]);
  let r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(r.waiting, 1);
  assert.equal(createCalls.length, 0);

  lines = [{ refundId: "gid://shopify/Refund/9", createdAt: "2026-11-23T03:00:00Z", gateway: "shopify_payments", formattedGateway: null, amount: 2500 }];
  r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(r.applied, 1);
  assert.deepEqual(createCalls.map((c) => [c.refundId, c.data.id, c.data.amount, c.data.actualRefundMethod, c.data.originalPaymentMethod]), [
    ["gid://shopify/Refund/9", "pos_rr_res1_0", 1000, "cash", "shopify_payments"],
    ["gid://shopify/Refund/9", "pos_rr_res1_1", 1500, "gift", "shopify_payments"],
  ]);
  assert.equal(reservations[0].status, "applied");
  assert.equal(reservations[0].appliedRefundId, "gid://shopify/Refund/9");
  assert.deepEqual(synced, ["5001"], "注文の記録 pos.adjustments を書き直す");
  // 注文の id は数字だけ（POS・純正の返金の付け替えと同じ形。残りの確かめが同じ行を数える）
  assert.equal(reservations[0].sourceOrderId, "5001");
  assert.deepEqual(createCalls.map((c) => c.data.sourceOrderId), ["5001", "5001"]);
  assert.equal(reservations[0].expectedAmount, 2500);

  // もう一度呼んでも作らない（使った予約は pending でない）
  createCalls = [];
  r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(createCalls.length, 0);
});

test("1 つの注文に使う前の予約は 1 つまで・手段は支払方法マスタから", async () => {
  await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }]);
  const again = await svc.createRefundReservation(admin, "shop1", { sourceOrderId: "5001", rows: [{ actualRefundMethod: "cash", eventType: "cash_refund" }], expectedAmount: 100 });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, "RESERVATION_EXISTS");

  reservations = [];
  const bad = await svc.createRefundReservation(admin, "shop1", { sourceOrderId: ORDER, rows: [{ actualRefundMethod: "paypay", eventType: "payment_method_override" }], expectedAmount: 100 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "REFUND_METHOD_NOT_IN_MASTER");
});

test("予約した日が終わったら使わない（期限切れ）", async () => {
  await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }]);
  today = "2026-11-24";
  const r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(r.expired, 1);
  assert.equal(reservations[0].status, "expired");
});

test("予約の額が返金額より大きいときは作らずに要確認", async () => {
  await reserve([
    { actualRefundMethod: "cash", eventType: "cash_refund", amount: 3000 },
    { actualRefundMethod: "gift", eventType: "payment_method_override" },
  ], 4000);
  lines = [{ refundId: "gid://shopify/Refund/9", createdAt: "2026-11-23T03:00:00Z", gateway: "shopify_payments", formattedGateway: null, amount: 2500 }];
  const r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(r.review, 1);
  assert.equal(createCalls.length, 0);
  assert.equal(reservations[0].status, "needs_review");
  assert.match(reservations[0].reviewReason, /返金の一覧から返金方法を変更して/);
});

test("付け替えが残りの決まりで断られたら、要確認にして作った行を残す", async () => {
  await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }]);
  lines = [{ refundId: "gid://shopify/Refund/9", createdAt: "2026-11-23T03:00:00Z", gateway: "shopify_payments", formattedGateway: null, amount: 2500 }];
  createFail = { status: 409, code: "NATIVE_REFUND_AMOUNT_EXCEEDED", message: "残りは ¥0 です" };
  const r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(r.review, 1);
  assert.equal(reservations[0].status, "needs_review");
});

test("取り消し: 使う前は取り消せる・使ったあとは取り消せない", async () => {
  const res = await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }]);
  const ok = await svc.cancelRefundReservation("shop1", res!.id);
  assert.equal(ok.ok, true);
  assert.equal(reservations[0].status, "cancelled");
  reservations[0].status = "applied";
  const ng = await svc.cancelRefundReservation("shop1", res!.id);
  assert.equal(ng.ok, false);
});

test("知らせのたびに Shopify を読まない: 使う前の予約がある注文だけ", async () => {
  assert.equal(await svc.hasPendingReservation("shop1", "5001"), false);
  await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }]);
  assert.equal(await svc.hasPendingReservation("shop1", "5001"), true);
});

test("返金額が予約の金額と違うときは作らずに要確認（T 2026-11-23）", async () => {
  await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }], 3000);
  lines = [{ refundId: "gid://shopify/Refund/9", createdAt: "2026-11-23T03:00:00Z", gateway: "shopify_payments", formattedGateway: null, amount: 2500 }];
  const r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(r.review, 1);
  assert.equal(createCalls.length, 0);
  assert.match(reservations[0].reviewReason, /予約の金額（¥3,000）と違った/);
});

test("予約: 返金する金額は要る・分けた額の合計はそれより小さく", async () => {
  const none = await svc.createRefundReservation(admin, "shop1", { sourceOrderId: ORDER, rows: [{ actualRefundMethod: "cash", eventType: "cash_refund" }], expectedAmount: "" });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.code, "INVALID_AMOUNT");
  const over = await svc.createRefundReservation(admin, "shop1", {
    sourceOrderId: ORDER,
    rows: [
      { actualRefundMethod: "cash", eventType: "cash_refund", amount: 2500 },
      { actualRefundMethod: "gift", eventType: "payment_method_override" },
    ],
    expectedAmount: 2500,
  });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.code, "INVALID_AMOUNT");
  assert.equal(reservations.length, 0);
});

test("予約した日のあとにできた返金には当てない（期限切れ）", async () => {
  await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }]);
  // 予約の日のうち（今日はまだ 23 日）に、別の日の返金が見えた
  lines = [{ refundId: "gid://shopify/Refund/9", createdAt: "2026-11-24T03:00:00Z", gateway: "shopify_payments", formattedGateway: null, amount: 2500 }];
  const r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(r.expired, 1);
  assert.equal(createCalls.length, 0);
  assert.equal(reservations[0].status, "expired");
});

test("管理画面でオフ: 予約できない（403）・当てない", async () => {
  await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }]);
  settings = { refundReservationEnabled: false };
  assert.equal(await svc.refundReservationEnabled("shop1"), false);
  lines = [{ refundId: "gid://shopify/Refund/9", createdAt: "2026-11-23T03:00:00Z", gateway: "shopify_payments", formattedGateway: null, amount: 2500 }];
  const r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.deepEqual(r, { applied: 0, review: 0, waiting: 0, expired: 0 });
  assert.equal(createCalls.length, 0);
  assert.equal(reservations[0].status, "pending", "予約は残す（オンに戻したら当てる）");
  reservations = [];
  const off = await svc.createRefundReservation(admin, "shop1", { sourceOrderId: ORDER, rows: [{ actualRefundMethod: "cash", eventType: "cash_refund" }], expectedAmount: 100 });
  assert.equal(off.ok, false);
  if (!off.ok) assert.equal(off.status, 403);
});

test("特殊返金設定でオフの種類は予約できない", async () => {
  settings = { refundReservationEnabled: true, enablePaymentMethodOverride: false };
  const r = await svc.createRefundReservation(admin, "shop1", { sourceOrderId: ORDER, rows: [{ actualRefundMethod: "gift", eventType: "payment_method_override" }], expectedAmount: 100 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "EVENT_TYPE_DISABLED");
});

test("同時の書き込みで断られたら、予約は使う前のまま残して次に続きを当てる", async () => {
  await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }]);
  lines = [{ refundId: "gid://shopify/Refund/9", createdAt: "2026-11-23T03:00:00Z", gateway: "shopify_payments", formattedGateway: null, amount: 2500 }];
  createFail = { status: 409, code: "CONCURRENT_UPDATE", message: "同時" };
  let r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(r.waiting, 1);
  assert.equal(reservations[0].status, "pending");
  createFail = null;
  r = await svc.applyRefundReservationsForOrder(admin, "shop1", "5001");
  assert.equal(r.applied, 1);
});

test("予約が同時に入って Serializable で断られたら 409", async () => {
  txFail = "P2034";
  const r = await svc.createRefundReservation(admin, "shop1", { sourceOrderId: ORDER, rows: [{ actualRefundMethod: "cash", eventType: "cash_refund" }], expectedAmount: 100 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "RESERVATION_EXISTS");
});

test("前の書き方（gid）で入った予約も探す", async () => {
  await reserve([{ actualRefundMethod: "cash", eventType: "cash_refund" }]);
  reservations[0].sourceOrderId = ORDER;
  assert.equal(await svc.hasPendingReservation("shop1", "5001"), true);
  assert.equal((await svc.listRefundReservations("shop1", "5001")).length, 1);
});
