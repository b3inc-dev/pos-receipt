/**
 * 特殊返金・商品券調整を注文メタフィールド pos.adjustments に残し、精算はそこから数える
 * （docs/ORDER_ADJUSTMENTS_METAFIELD.md）。登録・変更・無効化の API と精算・売上サマリーを、合成データで動かして確かめる。
 * （Prisma と Shopify GraphQL だけ差し替える。node --experimental-test-module-mocks が要る: npm test が付ける）
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const TARGET_DATE = "2026-11-20";
const LOC_GID = "gid://shopify/Location/1001";
const SHOP_ID = "shop1";

// ── 合成 Shopify: 現金 1,000 円・カード 2,000 円の売上だけの日 ──
function money(a: number) {
  return { shopMoney: { amount: String(a), currencyCode: "JPY" } };
}
const dayStartUtc = new Date(`${TARGET_DATE}T00:00:00+09:00`).getTime();
function mkOrder(i: number, gw: string, amount: number) {
  const iso = new Date(dayStartUtc + (i + 1) * 3600_000).toISOString();
  return {
    id: `gid://shopify/Order/${5000 + i}`,
    name: `#${5000 + i}`,
    note: null,
    cancelledAt: null,
    totalPriceSet: money(amount),
    currentTotalTaxSet: { shopMoney: { amount: String(Math.round(amount / 11)) } },
    totalTaxSet: { shopMoney: { amount: String(Math.round(amount / 11)) } },
    totalDiscountsSet: { shopMoney: { amount: "0" } },
    lineItems: { nodes: [{ quantity: 1, discountAllocations: [] }] },
    transactions: [
      { id: `t${i}`, createdAt: iso, kind: "SALE", status: "SUCCESS", amountSet: money(amount), gateway: gw, formattedGateway: gw, location: { id: LOC_GID } },
    ],
    refunds: [],
    tags: [],
    processedAt: iso,
    createdAt: iso,
    retailLocation: { id: LOC_GID },
  };
}
const orders = [mkOrder(0, "cash", 1000), mkOrder(1, "shopify_payments", 2000)];
/** 合成 Shopify の注文メタフィールド（注文 GID → pos.adjustments の値） */
const shopifyAdjustments = new Map<string, string>();
const shopifySummaries = new Map<string, string>();
/** 注文への書き込みを失敗させる回数（書き込みの失敗の試験） */
let failWrites = 0;
/** 書き込みの直前に呼ぶ（同時に登録された場面の試験） */
let onWrite: (() => void) | null = null;
/** 書き込みのすぐあとに呼ぶ（ほかのアプリがすぐ書き換える場面の試験） */
let afterWrite: (() => void) | null = null;
/** 注文への書き込みの回数 */
let writeCount = 0;
/** 商品券の支払いがある注文（④ 額面だけの試験） */
const voucherOrderTx = [
  { kind: "SALE", status: "SUCCESS", gateway: "商品券釣有り", formattedGateway: "商品券釣有り", amountSet: money(4200) },
];

function opName(q: string) {
  return /(query|mutation)\s+(\w+)/.exec(q)?.[2] ?? "anon";
}
const admin = {
  async graphql(query: string, opts?: { variables?: Record<string, unknown> }) {
    const name = opName(query);
    const v = opts?.variables ?? {};
    let data: unknown = {};
    switch (name) {
      case "SettlementOrders": {
        const q = String(v.query ?? "");
        const all = q.includes("status:cancelled") && !q.includes("-status:cancelled") ? [] : orders;
        data = { orders: { nodes: v.after ? [] : all, pageInfo: { hasNextPage: false, endCursor: null } } };
        break;
      }
      case "RefundsOrders":
        data = { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        break;
      case "ShopTimezone":
        data = { shop: { ianaTimezone: "Asia/Tokyo" } };
        break;
      case "OrderAdjustmentsDocs":
        data = {
          nodes: (v.ids as string[]).map((id) => ({
            id,
            adjustments: shopifyAdjustments.has(id) ? { value: shopifyAdjustments.get(id) } : null,
          })),
        };
        break;
      case "OrderAdjustmentsSet":
        if (failWrites > 0) {
          failWrites--;
          return { json: async () => ({ errors: [{ message: "Internal error" }] }) };
        }
        onWrite?.();
        for (const m of v.metafields as { ownerId: string; key: string; value: string }[]) {
          if (m.key === "adjustments") shopifyAdjustments.set(m.ownerId, m.value);
          if (m.key === "adjustments_summary") shopifySummaries.set(m.ownerId, m.value);
        }
        writeCount++;
        afterWrite?.();
        data = { metafieldsSet: { metafields: [], userErrors: [] } };
        break;
      case "OrderVoucherTransactions":
        data = { order: { id: v.id, name: "#5009", createdAt: `${TARGET_DATE}T03:00:00Z`, transactions: voucherOrderTx } };
        break;
      case "LegacyGiftCards":
      case "LegacyGiftCardsFb":
        data = { giftCards: { edges: [], nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        break;
      default:
        data = {};
    }
    return { json: async () => ({ data }) };
  },
};

// ── 合成 DB（Prisma 風） ──
const store: Record<string, any[]> = {
  shop: [{ id: SHOP_ID, shopDomain: "test.myshopify.com", planCode: "pro" }],
  appSetting: [],
  location: [{ id: "loc1", shopId: SHOP_ID, shopifyLocationGid: LOC_GID, name: "本店", displayName: "本店", printMode: "cloudprnt_direct", nonPosRefundAttributionEnabled: false }],
  settlement: [],
  specialRefundEvent: [],
  paymentMethodMaster: [],
  budget: [],
  footfallReport: [],
  salesSummaryCacheDaily: [],
};
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "shopId_key") {
      const c = cond as any;
      if (row.shopId !== c.shopId || row.key !== c.key) return false;
      continue;
    }
    if (k === "OR") {
      if (!(cond as any[]).some((w) => matchWhere(row, w))) return false;
      continue;
    }
    if (cond === null) {
      if (row[k] != null) return false;
      continue;
    }
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as any;
      if ("in" in c && !c.in.includes(row[k])) return false;
      if ("gte" in c && !(row[k] >= c.gte)) return false;
      if ("lte" in c && !(row[k] <= c.lte)) return false;
      if ("lt" in c && !(row[k] < c.lt)) return false;
      continue;
    }
    if (row[k] !== cond) return false;
  }
  return true;
}
let idSeq = 1;
function model(name: string) {
  const rows = () => (store[name] ??= []);
  return {
    findFirst: async (a: any = {}) => rows().find((x) => matchWhere(x, a.where)) ?? null,
    findUnique: async (a: any = {}) => rows().find((x) => matchWhere(x, a.where)) ?? null,
    findMany: async (a: any = {}) => rows().filter((x) => matchWhere(x, a.where)),
    count: async (a: any = {}) => rows().filter((x) => matchWhere(x, a.where)).length,
    create: async (a: any) => {
      // schema.prisma の @default / @updatedAt と同じ値を入れる
      const defaults = name === "specialRefundEvent" ? { approvalStatus: "none", approvalReviewedAt: null } : {};
      const row = { id: `${name}_${idSeq++}`, createdAt: new Date(), updatedAt: new Date(), ...defaults, ...a.data };
      rows().push(row);
      return row;
    },
    update: async (a: any) =>
      Object.assign(rows().find((x) => matchWhere(x, a.where)), a.data, { updatedAt: new Date() }),
    updateMany: async (a: any) => {
      const hit = rows().filter((x) => matchWhere(x, a.where));
      hit.forEach((x) => Object.assign(x, a.data));
      return { count: hit.length };
    },
    upsert: async (a: any) => {
      const key = Object.values(a.where)[0] as any;
      const row = rows().find((x) =>
        typeof key === "object" ? Object.entries(key).every(([k, v]) => x[k] === v) : matchWhere(x, a.where),
      );
      if (row) return Object.assign(row, a.update);
      const n = { id: `${name}_${idSeq++}`, createdAt: new Date(), ...a.create };
      rows().push(n);
      return n;
    },
    deleteMany: async () => ({ count: 0 }),
    groupBy: async () => [],
  };
}
const prismaMock = new Proxy({} as any, {
  get(target, prop: string) {
    if (prop === "then") return undefined;
    if (prop === "$transaction") return async (x: any) => (typeof x === "function" ? x(prismaMock) : Promise.all(x));
    return (target[prop] ??= model(prop));
  },
});
(globalThis as any).prismaGlobal = prismaMock;
mock.module(new URL("../db.server.ts", import.meta.url).href, { defaultExport: prismaMock });
// POS の認証だけ差し替える（登録 API を呼ぶ試験用）
const shopifyCalls: string[] = [];
const recordingAdmin = {
  async graphql(query: string, opts?: { variables?: Record<string, unknown> }) {
    shopifyCalls.push(opName(query));
    return admin.graphql(query, opts);
  },
};
mock.module(new URL("../utils/posAuth.server.ts", import.meta.url).href, {
  namedExports: {
    authenticatePosRequestOrCorsError: async () => ({
      admin: recordingAdmin,
      shop: store.shop[0],
      corsJson: (d: unknown, init?: ResponseInit) => Response.json(d, init),
    }),
    corsErrorJson: (_r: Request, d: unknown, status: number) => Response.json(d, { status }),
    corsPreflightResponse: () => new Response(null, { status: 204 }),
  },
});

/** 特殊返金設定。注文に書く設定（writeOrderAdjustmentsMetafield）は、指定が無ければオン */
function setSpecialRefundSettings(v: Record<string, unknown>) {
  store.appSetting = store.appSetting.filter((r) => r.key !== "special_refund_settings");
  store.appSetting.push({
    shopId: SHOP_ID,
    key: "special_refund_settings",
    valueJson: JSON.stringify({ writeOrderAdjustmentsMetafield: true, ...v }),
  });
}
setSpecialRefundSettings({ refundProcessingMode: "record_only" });


/** 一般設定のタイムゾーン（日本時間）。Shopify にも聞かずに済む */
store.appSetting.push({ shopId: SHOP_ID, key: "general_settings", valueJson: JSON.stringify({ defaultTimezone: "Asia/Tokyo" }) });
store.paymentMethodMaster = [
  { shopId: SHOP_ID, enabled: true, selectableForSpecialRefund: true, rawGatewayPattern: "cash", displayLabel: "現金" },
  { shopId: SHOP_ID, enabled: true, selectableForSpecialRefund: true, rawGatewayPattern: "facility_points", displayLabel: "施設ポイント" },
];

async function callRoute(path: string, modPath: string, body: Record<string, unknown>, params: Record<string, string> = {}) {
  const route = await import(modPath);
  const res = await route.action({
    request: new Request(`https://app.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    params,
  } as any);
  return { status: res.status, json: (await res.json()) as any };
}

async function preview(date = TARGET_DATE) {
  const engine = await import("./settlementEngine.server.ts");
  engineRef = engine;
  return engine.buildSettlementPreview(admin as any, SHOP_ID, LOC_GID, "本店", date);
}

function docOf(orderGid: string) {
  return JSON.parse(shopifyAdjustments.get(orderGid) ?? "null");
}

/** 記録のみの返金手段変更（カードで払った 500 円を現金で返した）を、その日の 14 時（日本時間）に登録したことにする */
let engineRef: any = null;
function putOverride(p: Record<string, unknown> = {}) {
  engineRef?.resetRecentAdjustmentRewritesForTest();
  store.specialRefundEvent = [
    {
      id: "ev1",
      shopId: SHOP_ID,
      sourceOrderId: "gid://shopify/Order/5001",
      sourceOrderName: "#5001",
      locationId: LOC_GID,
      eventType: "payment_method_override",
      originalPaymentMethod: "shopify_payments",
      actualRefundMethod: "cash",
      amount: 500,
      currency: "JPY",
      adjustKind: null,
      status: "active",
      shopifyRefundStatus: "skipped",
      shopifyRefundId: null,
      approvalStatus: "none",
      countDate: TARGET_DATE,
      replacesEventId: null,
      createdAt: new Date(dayStartUtc + 5 * 3600_000),
      // 初めは「注文に書く設定にしてから書いた注文」（前からの登録は metafieldSyncedAt: null で作る）
      metafieldSyncedAt: new Date(dayStartUtc + 5 * 3600_000),
      metafieldSyncError: null,
      ...p,
    },
  ];
}

async function writeDoc() {
  const { syncOrderAdjustmentsMetafield } = await import("./orderAdjustments.server.ts");
  return syncOrderAdjustmentsMetafield(admin as any, SHOP_ID, "gid://shopify/Order/5001");
}

test("登録 API: 特殊返金を登録すると注文メタフィールドに 1 行書き、精算はその値で数える", async () => {
  shopifyAdjustments.clear();
  store.specialRefundEvent = [];
  setSpecialRefundSettings({ refundProcessingMode: "record_only" });
  const { status, json } = await callRoute("/api/special-refunds", "../routes/api.special-refunds.tsx", {
    sourceOrderId: "gid://shopify/Order/5001",
    sourceOrderName: "#5001",
    locationId: LOC_GID,
    eventType: "payment_method_override",
    amount: 500,
    originalPaymentMethod: "shopify_payments",
    actualRefundMethod: "cash",
    createdBy: "山田",
  });
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.metafieldWritten, true);
  const doc = docOf("gid://shopify/Order/5001");
  assert.equal(doc.version, 1);
  assert.equal(doc.entries.length, 1);
  const e = doc.entries[0];
  assert.equal(e.type, "special_refund");
  assert.equal(e.kind, "payment_method_override");
  assert.equal(e.locationGid, LOC_GID);
  assert.equal(e.toMethod, "cash");
  assert.equal(e.toLabel, "現金");
  assert.equal(e.amount, 500);
  assert.equal(e.status, "active");
  assert.equal(e.shopifyRefund.status, "skipped");
  assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(store.specialRefundEvent[0].countDate, e.date);
  assert.ok(store.specialRefundEvent[0].metafieldSyncedAt instanceof Date);
  assert.match(String(shopifySummaries.get("gid://shopify/Order/5001")), /返金方法変更 .*→現金 ¥500/);
});

test("精算: 注文の値と DB が同じなら警告なしで数える（売上サマリーも同じ）", async () => {
  putOverride();
  shopifyAdjustments.clear();
  await writeDoc();
  const p = await preview();
  assert.equal(p.total, 2500);
  assert.equal(p.refundTotal, 500);
  assert.equal(p.adjustmentSourceWarnings, undefined);
  const summary = await import("./salesSummaryEngine.server.ts");
  const row = await summary.computeAndCacheDailySummary(admin as any, SHOP_ID, LOC_GID, "本店", TARGET_DATE);
  assert.equal(row.actual, p.netSales);
});

test("精算: Shopify の画面で金額を書き換えられても、アプリの記録で数え、注文の値を書き直す（T の決定）", async () => {
  putOverride();
  shopifyAdjustments.clear();
  await writeDoc();
  const doc = docOf("gid://shopify/Order/5001");
  doc.entries[0].amount = 800;
  shopifyAdjustments.set("gid://shopify/Order/5001", JSON.stringify(doc));
  const p = await preview();
  assert.equal(p.refundTotal, 500);
  assert.equal(p.total, 2500);
  assert.equal(p.adjustmentSourceWarnings, undefined);
  assert.equal(docOf("gid://shopify/Order/5001").entries[0].amount, 500);
});

test("精算: 注文に書く設定にする前の登録は、精算では書かない。特殊返金設定の「前からの登録を注文に書く」で書く（見直し P2-A）", async () => {
  putOverride({ metafieldSyncedAt: null, metafieldSyncError: null });
  shopifyAdjustments.clear();
  writeCount = 0;
  const p = await preview();
  assert.equal(p.refundTotal, 500);
  assert.equal(p.adjustmentSourceWarnings, undefined);
  assert.equal(writeCount, 0);
  assert.equal(shopifyAdjustments.has("gid://shopify/Order/5001"), false);
  const { backfillOrderAdjustmentsMetafield, countOrdersNotWrittenYet } = await import("./orderAdjustments.server.ts");
  assert.equal(await countOrdersNotWrittenYet(SHOP_ID), 1);
  const r = await backfillOrderAdjustmentsMetafield(admin as any, SHOP_ID, 1);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.written, [{ orderName: "#5001" }]);
  assert.equal(r.ok && r.remaining, 0);
  assert.equal(docOf("gid://shopify/Order/5001").entries[0].amount, 500);
  assert.ok(store.specialRefundEvent[0].metafieldSyncedAt instanceof Date);
});

test("精算: 書き直してもほかのアプリがすぐ書き換えるときは知らせ、少しのあいだ続けて書き直さない（見直し P2-A）", async () => {
  putOverride();
  shopifyAdjustments.clear();
  await writeDoc();
  const tamper = () => {
    const doc = docOf("gid://shopify/Order/5001");
    doc.entries[0].amount = 800;
    shopifyAdjustments.set("gid://shopify/Order/5001", JSON.stringify(doc));
  };
  tamper();
  afterWrite = tamper;
  writeCount = 0;
  const p = await preview();
  assert.equal(p.refundTotal, 500);
  assert.equal(writeCount, 1);
  assert.equal(p.adjustmentSourceWarnings?.[0].reason, "metafield_differs_again");
  const q = await preview();
  afterWrite = null;
  assert.equal(writeCount, 1);
  assert.equal(q.refundTotal, 500);
  assert.equal(q.adjustmentSourceWarnings?.[0].reason, "metafield_differs_again");
  assert.match(String(q.adjustmentSourceWarnings?.[0].message), /続けて書き直すことはしない/);
});

test("精算: 注文にまだ書けていない注文は、DB の行で数えて書き直す。書き直せなければ警告", async () => {
  putOverride();
  shopifyAdjustments.clear();
  const p = await preview();
  assert.equal(p.refundTotal, 500);
  assert.equal(p.adjustmentSourceWarnings, undefined);
  assert.equal(docOf("gid://shopify/Order/5001").entries.length, 1);
  shopifyAdjustments.clear();
  failWrites = 99;
  const q = await preview();
  failWrites = 0;
  assert.equal(q.refundTotal, 500);
  assert.equal(q.adjustmentSourceWarnings?.[0].reason, "metafield_missing");
  assert.match(String(q.adjustmentSourceWarnings?.[0].message), /#5001.*アプリの記録で数えて/);
});

test("変更のあと注文への書き込みが失敗しても、精算は新しい行で数える（前の行で数えない）", async () => {
  putOverride({ amount: 1000 });
  shopifyAdjustments.clear();
  await writeDoc();
  failWrites = 99;
  const { status, json } = await callRoute(
    "/api/special-refunds/ev1/edit",
    "../routes/api.special-refunds.$id.edit.tsx",
    { amount: 600, reason: "金額の入れ間違い" },
    { id: "ev1" },
  );
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.metafieldWritten, false);
  assert.ok(store.specialRefundEvent[0].metafieldSyncError);
  const p = await preview();
  failWrites = 0;
  assert.equal(p.refundTotal, 600);
  assert.equal(p.adjustmentSourceWarnings?.[0].reason, "metafield_differs");
});

test("同時に登録: 書いている間にほかの端末が 2 件目を足しても、書いたあとに作り直して 2 件とも残す", async () => {
  putOverride();
  shopifyAdjustments.clear();
  let added = false;
  onWrite = () => {
    if (added) return;
    added = true;
    store.specialRefundEvent.push({
      ...store.specialRefundEvent[0],
      id: "ev2",
      amount: 300,
      createdAt: new Date(dayStartUtc + 6 * 3600_000),
    });
  };
  const r = await writeDoc();
  onWrite = null;
  assert.equal(r.ok, true);
  assert.deepEqual(docOf("gid://shopify/Order/5001").entries.map((e: any) => e.id), ["ev1", "ev2"]);
});

test("注文に書く設定がオフのときは、注文に何も書かず・読まず、精算は DB で数えて警告もしない", async () => {
  setSpecialRefundSettings({ refundProcessingMode: "record_only", writeOrderAdjustmentsMetafield: false });
  putOverride();
  shopifyAdjustments.clear();
  shopifyCalls.length = 0;
  const r = await writeDoc();
  assert.deepEqual(r, { ok: true, skipped: true });
  assert.equal(shopifyAdjustments.size, 0);
  const p = await preview();
  assert.equal(p.refundTotal, 500);
  assert.equal(p.adjustmentSourceWarnings, undefined);
  assert.equal(shopifyAdjustments.size, 0);
  setSpecialRefundSettings({ refundProcessingMode: "record_only" });
});

test("前からの行（countDate なし）は登録した日で数える", async () => {
  putOverride({ countDate: null });
  shopifyAdjustments.clear();
  await writeDoc();
  const p = await preview();
  assert.equal(p.refundTotal, 500);
  assert.equal(p.adjustmentSourceWarnings, undefined);
  const next = await preview("2026-11-21");
  assert.equal(next.refundTotal, 0);
});

test("変更 API（元の日のまま）: 前の行を無効にし、置き換えの行を足して、注文の値も直す", async () => {
  putOverride();
  shopifyAdjustments.clear();
  await writeDoc();
  const { status, json } = await callRoute(
    "/api/special-refunds/ev1/edit",
    "../routes/api.special-refunds.$id.edit.tsx",
    { amount: 700, actualRefundMethod: "facility_points", reason: "手段と金額の入れ間違い", by: "佐藤" },
    { id: "ev1" },
  );
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.voidedEventId, "ev1");
  assert.equal(store.specialRefundEvent.length, 2);
  const [old, neu] = store.specialRefundEvent;
  assert.equal(old.status, "voided");
  assert.equal(old.voidReason, "手段と金額の入れ間違い");
  assert.equal(neu.replacesEventId, "ev1");
  assert.equal(neu.countDate, TARGET_DATE);
  assert.equal(neu.shopifyRefundStatus, "skipped");
  const doc = docOf("gid://shopify/Order/5001");
  assert.deepEqual(doc.entries.map((e: any) => e.status), ["voided", "active"]);
  assert.equal(doc.entries[0].replacedBy, neu.id);
  assert.equal(doc.entries[1].toLabel, "施設ポイント");
  const p = await preview();
  assert.equal(p.refundTotal, 700);
  assert.equal(p.adjustmentSourceWarnings, undefined);
  // 同じ行をもう一度直そうとしても断る
  const again = await callRoute(
    "/api/special-refunds/ev1/edit",
    "../routes/api.special-refunds.$id.edit.tsx",
    { amount: 600, reason: "x" },
    { id: "ev1" },
  );
  assert.equal(again.status, 409);
});

test("変更 API: マスタで選べない返金手段には直せない", async () => {
  putOverride();
  const { status, json } = await callRoute(
    "/api/special-refunds/ev1/edit",
    "../routes/api.special-refunds.$id.edit.tsx",
    { actualRefundMethod: "unknown_points", reason: "x" },
    { id: "ev1" },
  );
  assert.equal(status, 400);
  assert.equal(json.code, "REFUND_METHOD_NOT_IN_MASTER");
  assert.equal(store.specialRefundEvent.length, 1);
  assert.equal(store.specialRefundEvent[0].status, "active");
});

test("変更 API（今日にする）: 前の日の精算から抜けて、今日に入る", async () => {
  putOverride();
  shopifyAdjustments.clear();
  await writeDoc();
  const { status } = await callRoute(
    "/api/special-refunds/ev1/edit",
    "../routes/api.special-refunds.$id.edit.tsx",
    { reason: "今日の分にする", dateMode: "today" },
    { id: "ev1" },
  );
  assert.equal(status, 200);
  const p = await preview();
  assert.equal(p.refundTotal, 0);
  assert.equal(p.adjustmentSourceWarnings, undefined);
});

test("変更 API: Shopify で返金済みの行は、返金の記録を引き継いで付け替えだけ（返金の総額は変わらない）", async () => {
  putOverride({ shopifyRefundStatus: "success", shopifyRefundId: "gid://shopify/Refund/9", eventType: "cash_refund" });
  shopifyAdjustments.clear();
  await writeDoc();
  const before = await preview();
  const { status, json } = await callRoute(
    "/api/special-refunds/ev1/edit",
    "../routes/api.special-refunds.$id.edit.tsx",
    { actualRefundMethod: "facility_points", reason: "手段の入れ間違い" },
    { id: "ev1" },
  );
  assert.equal(status, 200, JSON.stringify(json));
  assert.match(String(json.warning), /Shopify の返金はそのまま/);
  const neu = store.specialRefundEvent[1];
  assert.equal(neu.shopifyRefundStatus, "success");
  assert.equal(neu.shopifyRefundId, "gid://shopify/Refund/9");
  const after = await preview();
  assert.equal(after.refundTotal, before.refundTotal);
});

test("無効化 API: わけを残し、注文の値も無効にする。精算から抜ける", async () => {
  putOverride();
  shopifyAdjustments.clear();
  await writeDoc();
  const { status, json } = await callRoute(
    "/api/special-refunds/ev1/void",
    "../routes/api.special-refunds.$id.void.tsx",
    { reason: "二重に登録した", by: "山田" },
    { id: "ev1" },
  );
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(store.specialRefundEvent[0].voidReason, "二重に登録した");
  const doc = docOf("gid://shopify/Order/5001");
  assert.equal(doc.entries[0].status, "voided");
  const p = await preview();
  assert.equal(p.refundTotal, 0);
});

test("商品券 API: 額面だけ送れば、使った額を注文の取引から出し、お釣りを残す", async () => {
  store.specialRefundEvent = [];
  shopifyAdjustments.clear();
  const { status, json } = await callRoute("/api/voucher-adjustments", "../routes/api.voucher-adjustments.tsx", {
    sourceOrderId: "gid://shopify/Order/5009",
    sourceOrderName: "#5009",
    locationId: LOC_GID,
    voucherFaceValue: 5000,
  });
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.appliedFromOrder, true);
  assert.equal(json.event.voucherAppliedAmount, "4200");
  assert.equal(json.event.voucherChangeAmount, "800");
  const doc = docOf("gid://shopify/Order/5009");
  assert.equal(doc.entries[0].type, "voucher");
  assert.deepEqual(doc.entries[0].voucher, { face: 5000, applied: 4200, change: 800 });
  // 数える日は注文の日（T の決定）。精算の「商品券釣有り差額」に入る
  assert.equal(json.event.countDate, TARGET_DATE);
  const p = await preview(TARGET_DATE);
  assert.equal(p.voucherChangeAmount, 800);
});

test("商品券 API: 注文に商品券の支払いが見つからないときは 400（お釣り＝額面で登録しない）", async () => {
  store.specialRefundEvent = [];
  const saved = voucherOrderTx.splice(0, voucherOrderTx.length);
  voucherOrderTx.push({ kind: "SALE", status: "SUCCESS", gateway: "cash", formattedGateway: "cash", amountSet: money(5000) });
  const { status, json } = await callRoute("/api/voucher-adjustments", "../routes/api.voucher-adjustments.tsx", {
    sourceOrderId: "gid://shopify/Order/5009",
    sourceOrderName: "#5009",
    locationId: LOC_GID,
    voucherFaceValue: 5000,
  });
  voucherOrderTx.splice(0, voucherOrderTx.length, ...saved);
  assert.equal(status, 400);
  assert.equal(json.code, "VOUCHER_APPLIED_UNKNOWN");
  assert.equal(store.specialRefundEvent.length, 0);
});

test("自動の確定（#88）で返金処理中から決まったら、注文の記録の返金の状態も同じにする", async () => {
  putOverride({ shopifyRefundStatus: "pending" });
  shopifyAdjustments.clear();
  await writeDoc();
  assert.equal(docOf("gid://shopify/Order/5001").entries[0].shopifyRefund.status, "pending");
  // 自動の確定が DB を success にしたあと
  store.specialRefundEvent[0].shopifyRefundStatus = "success";
  store.specialRefundEvent[0].shopifyRefundId = "gid://shopify/Refund/9";
  const { afterSpecialRefundsResolved } = await import("./specialRefundAutoResolve.server.ts");
  await afterSpecialRefundsResolved(
    admin as any,
    SHOP_ID,
    [{ id: "ev1", sourceOrderId: "gid://shopify/Order/5001", locationId: LOC_GID, status: "success" } as any],
    { refreshDailySummary: false },
  );
  assert.equal(docOf("gid://shopify/Order/5001").entries[0].shopifyRefund.status, "success");
});
