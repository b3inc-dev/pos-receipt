/**
 * 特殊返金「支払方法の付け替え」の管理者の承認: 精算エンジンと売上サマリーで同じになることを、
 * 実際の buildSettlementPreview / computeAndCacheDailySummary を合成データで動かして確かめる。
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

function setSpecialRefundSettings(v: Record<string, unknown>) {
  store.appSetting = store.appSetting.filter((r) => r.key !== "special_refund_settings");
  store.appSetting.push({ shopId: SHOP_ID, key: "special_refund_settings", valueJson: JSON.stringify(v) });
}

/** 記録のみの返金手段変更（カードで払った 500 円を現金で返した） */
function putOverride(approvalStatus: string) {
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
      adjustKind: null,
      status: "active",
      shopifyRefundStatus: "skipped",
      approvalStatus,
      createdAt: new Date(dayStartUtc + 5 * 3600_000),
    },
  ];
}

async function runBoth() {
  const engine = await import("./settlementEngine.server.ts");
  const summary = await import("./salesSummaryEngine.server.ts");
  const preview = await engine.buildSettlementPreview(admin as any, SHOP_ID, LOC_GID, "本店", TARGET_DATE);
  const row = await summary.computeAndCacheDailySummary(admin as any, SHOP_ID, LOC_GID, "本店", TARGET_DATE);
  const cache = store.salesSummaryCacheDaily.find((r) => r.targetDate === TARGET_DATE);
  return { preview, row, cache };
}

test("承認の設定がオフ（初めの値）: 付け替えは今までどおり登録した時点で精算・売上サマリーに入る", async () => {
  setSpecialRefundSettings({ refundProcessingMode: "record_only" });
  putOverride("none");
  const { preview, row, cache } = await runBoth();
  assert.equal(preview.total, 2500); // 3,000 − 500
  assert.equal(preview.refundTotal, 500);
  assert.equal(preview.awaitingApprovalSpecialRefunds, undefined);
  assert.equal(preview.appliedSpecialRefundEvents.length, 1);
  assert.equal(row.actual, preview.netSales);
  assert.equal(Number(cache.actual), preview.netSales);
});

test("承認待ち: 精算・売上サマリーのどちらにも入らず、精算には警告が出る", async () => {
  setSpecialRefundSettings({ refundProcessingMode: "record_only", requireApprovalForPaymentMethodOverride: true });
  putOverride("pending");
  const { preview, row, cache } = await runBoth();
  assert.equal(preview.total, 3000);
  assert.equal(preview.refundTotal, 0);
  assert.equal(preview.appliedSpecialRefundEvents.length, 0);
  assert.equal(preview.awaitingApprovalSpecialRefunds?.length, 1);
  assert.equal(preview.awaitingApprovalSpecialRefunds?.[0].amount, 500);
  assert.match(String(preview.awaitingApprovalWarning), /承認待ち.*1 件.*#5001/);
  assert.equal(row.actual, preview.netSales);
  assert.equal(Number(cache.actual), preview.netSales);
});

test("承認したあと: オフのときと同じ数になる（精算・売上サマリーとも）", async () => {
  putOverride("approved");
  const { preview, row, cache } = await runBoth();
  assert.equal(preview.total, 2500);
  assert.equal(preview.refundTotal, 500);
  assert.equal(preview.awaitingApprovalSpecialRefunds, undefined);
  assert.equal(row.actual, preview.netSales);
  assert.equal(Number(cache.actual), preview.netSales);
});

test("却下: 入らず、警告も出ない（精算・売上サマリーとも）", async () => {
  putOverride("rejected");
  const { preview, row, cache } = await runBoth();
  assert.equal(preview.total, 3000);
  assert.equal(preview.refundTotal, 0);
  assert.equal(preview.awaitingApprovalSpecialRefunds, undefined);
  assert.equal(row.actual, preview.netSales);
  assert.equal(Number(cache.actual), preview.netSales);
});

test("承認待ちでも Shopify 返金の成否が分からない（pending）ものは確定を止める", async () => {
  putOverride("pending");
  store.specialRefundEvent[0].shopifyRefundStatus = "pending";
  const engine = await import("./settlementEngine.server.ts");
  await assert.rejects(
    () => engine.buildSettlementPreview(admin as any, SHOP_ID, LOC_GID, "本店", TARGET_DATE),
    (err: Error) => err.name === "SpecialRefundPendingError",
  );
});

test("承認／却下: 承認待ちだけを書き換え、Shopify には何も書かない", async () => {
  putOverride("pending");
  const calls: string[] = [];
  const spyAdmin = {
    async graphql(query: string, opts?: { variables?: Record<string, unknown> }) {
      calls.push(opName(query));
      return admin.graphql(query, opts);
    },
  };
  const { decideSpecialRefundApproval } = await import("./specialRefundApproval.server.ts");
  const r1 = await decideSpecialRefundApproval(spyAdmin as any, SHOP_ID, "ev1", "approve");
  assert.equal(r1.ok, true);
  assert.equal(store.specialRefundEvent[0].approvalStatus, "approved");
  assert.ok(store.specialRefundEvent[0].approvalReviewedAt instanceof Date);
  assert.ok(calls.every((c) => !/^mutation|Create|Update|Set$/i.test(c)), `Shopify mutations: ${calls.join(",")}`);
  // 2 回目（ほかの人が先に決めた）は断る
  const r2 = await decideSpecialRefundApproval(spyAdmin as any, SHOP_ID, "ev1", "reject");
  assert.equal(r2.ok, false);
  assert.equal(store.specialRefundEvent[0].approvalStatus, "approved");
  // 売上サマリーのキャッシュは承認後の数
  const cache = store.salesSummaryCacheDaily.find((r) => r.targetDate === TARGET_DATE);
  const engine = await import("./settlementEngine.server.ts");
  const preview = await engine.buildSettlementPreview(admin as any, SHOP_ID, LOC_GID, "本店", TARGET_DATE);
  assert.equal(Number(cache.actual), preview.netSales);
  assert.equal(preview.total, 2500);
});

async function postSpecialRefund(body: Record<string, unknown>) {
  const route = await import("../routes/api.special-refunds.tsx");
  const res = await route.action({
    request: new Request("https://app.test/api/special-refunds", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  } as any);
  return { status: res.status, json: (await res.json()) as any };
}

const overrideBody = {
  sourceOrderId: "gid://shopify/Order/5001",
  sourceOrderName: "#5001",
  locationId: LOC_GID,
  eventType: "payment_method_override",
  amount: 500,
  originalPaymentMethod: "shopify_payments",
  actualRefundMethod: "cash",
};

test("登録 API: 設定オン（記録のみ）の返金手段変更は承認待ちで登録し、Shopify に書かない", async () => {
  store.specialRefundEvent = [];
  store.paymentMethodMaster = [
    { shopId: SHOP_ID, enabled: true, selectableForSpecialRefund: true, rawGatewayPattern: "cash", displayLabel: "現金" },
  ];
  setSpecialRefundSettings({ refundProcessingMode: "record_only", requireApprovalForPaymentMethodOverride: true });
  shopifyCalls.length = 0;
  const { status, json } = await postSpecialRefund(overrideBody);
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.approvalRequired, true);
  assert.equal(json.event.approvalStatus, "pending");
  assert.equal(json.event.shopifyRefundStatus, "skipped");
  assert.equal(store.specialRefundEvent[0].approvalStatus, "pending");
  assert.ok(!shopifyCalls.includes("refundCreate") && !shopifyCalls.some((c) => /Refund/.test(c)), shopifyCalls.join(","));
});

test("登録 API: 設定オフ（初めの値）は今までどおり（承認の対象外）", async () => {
  store.specialRefundEvent = [];
  setSpecialRefundSettings({ refundProcessingMode: "record_only" });
  const { status, json } = await postSpecialRefund(overrideBody);
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.approvalRequired, false);
  assert.equal(json.event.approvalStatus, "none");
});

test("登録 API: 設定オンでも現金返金は承認の対象外", async () => {
  store.specialRefundEvent = [];
  setSpecialRefundSettings({ refundProcessingMode: "record_only", requireApprovalForPaymentMethodOverride: true });
  const { status, json } = await postSpecialRefund({ ...overrideBody, eventType: "cash_refund", originalPaymentMethod: null });
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json.event.approvalStatus, "none");
});
