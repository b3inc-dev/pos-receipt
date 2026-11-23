/**
 * 売上サマリーと精算の整合の試験（連絡帳 #39 2026-11-23 05:06 UTC の依頼 2）。
 *
 * AGENTS.md「金額に触れる変更は精算エンジンと売上サマリーの整合を確かめる」を、毎回の `npm test` で確かめる。
 * 合成データだけを使い、実店舗・実注文の値は使わない。Shopify / DB には繋がない。
 *
 * - Shopify: `admin.graphql` を合成の注文で答える偽物にする（注文の検索条件 location_id / 日付 / status を読んで絞る）
 * - DB: `app/db.server.ts` は `globalThis.prismaGlobal` があればそれを使うので、読み込む前にメモリ上の偽物を置く
 * - 管理画面の予算 CSV（`app.budget-management.tsx`）は `shopify.server` の `authenticate.admin` だけを
 *   読み込みフック（module.register）で差し替えて、本物の action を呼ぶ
 *
 * 確かめること:
 * 1. 売上サマリーの日・店の純売上（actual）・件数・点数 ＝ 精算プレビューの netSales・orderCount・itemCount
 *    （computeAndCacheDailySummary、日次ペイロードの計算し直しとキャッシュ読み、の 3 経路）
 * 2. 返金の計上店の設定（refundAggregationLocationMode 2 値 × nonPosRefundFallbackMode 2 値）のどれでも 1 が成り立ち、
 *    設定で返金の行き先が実際に変わる
 * 3. 予算 CSV の読み取り（日本語ヘッダー・BOM・CRLF・¥ とカンマ・空欄・知らない店・旧ヘッダー）と、
 *    取り込んだ予算が売上サマリーの予算・予算比に出ること
 *
 * アプリのコードは変えない（試験のファイルだけ）。
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { before, describe, it } from "node:test";

// ---------------------------------------------------------------------------
// shopify.server の差し替え（管理画面ルートの authenticate.admin だけ）
// ---------------------------------------------------------------------------

const SHOPIFY_SERVER_STUB = `export const authenticate = { admin: (request) => globalThis.__ssTestAuthenticateAdmin(request) };`;
const RESOLVE_HOOK = `
const STUB = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(SHOPIFY_SERVER_STUB)}`)};
export async function resolve(specifier, context, next) {
  if (/(^|\\/)shopify\\.server(\\.ts)?$/.test(specifier)) return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(RESOLVE_HOOK)}`, import.meta.url);

// ---------------------------------------------------------------------------
// 合成 DB（Prisma の使う所だけ）
// ---------------------------------------------------------------------------

type Row = Record<string, any>;
const OPS = new Set(["in", "gte", "lte", "gt", "lt", "not", "contains"]);
const store: Record<string, Row[]> = {};
let idSeq = 1;

function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const keys = Object.keys(cond);
      if (keys.some((x) => OPS.has(x))) {
        const v = row[k];
        if ("in" in cond && !cond.in.includes(v)) return false;
        if ("gte" in cond && !(v >= cond.gte)) return false;
        if ("lte" in cond && !(v <= cond.lte)) return false;
        if ("gt" in cond && !(v > cond.gt)) return false;
        if ("lt" in cond && !(v < cond.lt)) return false;
        if ("not" in cond && v === cond.not) return false;
        continue;
      }
      // 複合ユニーク（shopId_key など）: 中のキーをそのまま比べる
      if (!matchWhere(row, cond)) return false;
      continue;
    }
    if (row[k] !== cond) return false;
  }
  return true;
}

function model(name: string) {
  const rows = () => (store[name] ??= []);
  return {
    findFirst: async (a: Row = {}) => rows().find((x) => matchWhere(x, a.where)) ?? null,
    findUnique: async (a: Row = {}) => rows().find((x) => matchWhere(x, a.where)) ?? null,
    findMany: async (a: Row = {}) => rows().filter((x) => matchWhere(x, a.where)),
    count: async (a: Row = {}) => rows().filter((x) => matchWhere(x, a.where)).length,
    create: async (a: Row) => {
      const row = { id: `${name}_${idSeq++}`, createdAt: new Date(), updatedAt: new Date(), ...a.data };
      rows().push(row);
      return row;
    },
    upsert: async (a: Row) => {
      const row = rows().find((x) => matchWhere(x, a.where));
      if (row) return Object.assign(row, a.update, { updatedAt: new Date() });
      const n = { id: `${name}_${idSeq++}`, createdAt: new Date(), updatedAt: new Date(), ...a.create };
      rows().push(n);
      return n;
    },
    update: async (a: Row) => Object.assign(rows().find((x) => matchWhere(x, a.where))!, a.data),
    deleteMany: async (a: Row = {}) => {
      const before = rows().length;
      store[name] = rows().filter((x) => !matchWhere(x, a.where));
      return { count: before - store[name].length };
    },
  };
}

const prismaMock: any = new Proxy({} as Row, {
  get(target, prop: string) {
    if (prop === "then") return undefined;
    if (prop === "$transaction") {
      return async (x: unknown) => (typeof x === "function" ? (x as (p: unknown) => unknown)(prismaMock) : Promise.all(x as unknown[]));
    }
    return (target[prop] ??= model(prop));
  },
});
(globalThis as any).prismaGlobal = prismaMock;

// ---------------------------------------------------------------------------
// 合成 Shopify
// ---------------------------------------------------------------------------

const SHOP_ID = "shop_ss_test";
const SHOP_DOMAIN = "ss-test.myshopify.com";
const STORE_A = "gid://shopify/Location/100";
const STORE_B = "gid://shopify/Location/200";
const STORE_A_NAME = "本店";
const STORE_B_NAME = "駅前店";

/** 対象日（JST）。前日に売れて対象日に返金される注文を作る */
const DAY = "2026-11-20";
const DAY_PREV = "2026-11-19";
/** JST の昼（どちらの日か迷わない時刻） */
const at = (ymd: string, hhmm = "12:00") => new Date(`${ymd}T${hhmm}:00+09:00`).toISOString();

const money = (amount: number) => ({ shopMoney: { amount: String(amount), currencyCode: "JPY" } });

type SynthOrder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  processedAt: string;
  cancelledAt: string | null;
  note: string | null;
  tags: string[];
  taxesIncluded: boolean;
  totalPriceSet: ReturnType<typeof money>;
  currentTotalTaxSet: { shopMoney: { amount: string } };
  totalTaxSet: { shopMoney: { amount: string } };
  totalDiscountsSet: { shopMoney: { amount: string } };
  lineItems: { nodes: { quantity: number; discountAllocations: never[]; customAttributes: never[] }[] };
  transactions: Row[];
  refunds: Row[];
  retailLocation: { id: string } | null;
};

function order(opts: {
  n: number;
  at: string;
  updatedAt?: string;
  location: string;
  gateway: string;
  amount: number;
  qty: number;
  refunds?: { at: string; qty: number; amount: number; gateway: string; location: string | null }[];
  tags?: string[];
}): SynthOrder {
  const tax = Math.round(opts.amount / 11);
  return {
    id: `gid://shopify/Order/${opts.n}`,
    name: `#${opts.n}`,
    createdAt: opts.at,
    updatedAt: opts.updatedAt ?? opts.refunds?.at(-1)?.at ?? opts.at,
    processedAt: opts.at,
    cancelledAt: null,
    note: null,
    tags: opts.tags ?? [],
    taxesIncluded: true,
    totalPriceSet: money(opts.amount),
    currentTotalTaxSet: { shopMoney: { amount: String(tax) } },
    totalTaxSet: { shopMoney: { amount: String(tax) } },
    totalDiscountsSet: { shopMoney: { amount: "0" } },
    lineItems: { nodes: [{ quantity: opts.qty, discountAllocations: [], customAttributes: [] }] },
    transactions: [
      {
        id: `gid://shopify/OrderTransaction/${opts.n}1`,
        createdAt: opts.at,
        kind: "SALE",
        status: "SUCCESS",
        amountSet: money(opts.amount),
        gateway: opts.gateway,
        formattedGateway: opts.gateway,
        location: { id: opts.location },
      },
      ...(opts.refunds ?? []).map((r, i) => ({
        id: `gid://shopify/OrderTransaction/${opts.n}9${i}`,
        createdAt: r.at,
        kind: "REFUND",
        status: "SUCCESS",
        amountSet: money(r.amount),
        gateway: r.gateway,
        formattedGateway: r.gateway,
        location: r.location ? { id: r.location } : null,
      })),
    ],
    refunds: (opts.refunds ?? []).map((r, i) => ({
      id: `gid://shopify/Refund/${opts.n}${i}`,
      createdAt: r.at,
      refundLineItems: { nodes: r.qty > 0 ? [{ quantity: r.qty, lineItem: { id: `li${opts.n}` } }] : [] },
      totalRefundedSet: money(r.amount),
      transactions: {
        nodes: [
          {
            id: `gid://shopify/OrderTransaction/${opts.n}9${i}`,
            kind: "REFUND",
            gateway: r.gateway,
            formattedGateway: r.gateway,
            amountSet: money(r.amount),
            location: r.location ? { id: r.location } : null,
          },
        ],
      },
    })),
    retailLocation: { id: opts.location },
  };
}

/**
 * 合成の注文（両店・対象日と前日）。
 * - 1001〜1003: 本店の対象日の売上（現金・カード・QR）
 * - 1004: 本店で前日に売れて、対象日に「駅前店の POS」で返金（返金の計上店の設定で行き先が変わる）
 * - 1005: 本店の対象日の売上を、対象日に管理画面で一部返金（POS の場所なし。fallback の設定で行き先が変わる）
 * - 1006: 駅前店の対象日の売上
 * - 1007: 精算注文（tag settlement）。どちらにも数えない
 * - 1008: 本店の前日の売上（対象日には数えない）
 */
const ORDERS: SynthOrder[] = [
  order({ n: 1001, at: at(DAY, "10:05"), location: STORE_A, gateway: "cash", amount: 3300, qty: 1 }),
  order({ n: 1002, at: at(DAY, "11:20"), location: STORE_A, gateway: "shopify_payments", amount: 5500, qty: 2 }),
  order({ n: 1003, at: at(DAY, "15:40"), location: STORE_A, gateway: "paypay", amount: 2200, qty: 1 }),
  order({
    n: 1004,
    at: at(DAY_PREV, "13:00"),
    location: STORE_A,
    gateway: "shopify_payments",
    amount: 4400,
    qty: 2,
    refunds: [{ at: at(DAY, "16:10"), qty: 1, amount: 2200, gateway: "shopify_payments", location: STORE_B }],
  }),
  order({
    n: 1005,
    at: at(DAY, "12:30"),
    location: STORE_A,
    gateway: "cash",
    amount: 6600,
    qty: 3,
    refunds: [{ at: at(DAY, "18:00"), qty: 1, amount: 1100, gateway: "cash", location: null }],
  }),
  order({ n: 1006, at: at(DAY, "14:00"), location: STORE_B, gateway: "cash", amount: 11000, qty: 4 }),
  order({ n: 1007, at: at(DAY, "21:00"), location: STORE_A, gateway: "cash", amount: 1, qty: 1, tags: ["SETTLEMENT"] }),
  order({ n: 1008, at: at(DAY_PREV, "17:00"), location: STORE_A, gateway: "cash", amount: 9900, qty: 5 }),
];

/** Shopify の location_id 検索の近似: 注文の店か、その注文の取引のどれかの場所 */
function orderTouchesLocation(o: SynthOrder, locNum: string): boolean {
  const ids = [o.retailLocation?.id, ...o.transactions.map((t) => t.location?.id)].filter(Boolean) as string[];
  return ids.some((id) => id.endsWith(`/${locNum}`));
}

function searchOrders(query: string): SynthOrder[] {
  const loc = /location_id:(\d+)/.exec(query)?.[1];
  const field = /(created_at|updated_at|processed_at):>=/.exec(query)?.[1] as
    | "created_at"
    | "updated_at"
    | "processed_at"
    | undefined;
  const from = new RegExp(`${field}:>=(\\S+)`).exec(query)?.[1];
  const to = new RegExp(`${field}:<=(\\S+)`).exec(query)?.[1];
  const wantCancelled = /(^|\s)status:cancelled/.test(query);
  const key = field === "created_at" ? "createdAt" : field === "updated_at" ? "updatedAt" : "processedAt";
  return ORDERS.filter((o) => {
    if (loc && !orderTouchesLocation(o, loc)) return false;
    if (/tag_not:settlement/.test(query) && o.tags.some((t) => t.toLowerCase() === "settlement")) return false;
    if (wantCancelled !== Boolean(o.cancelledAt)) return false;
    if (field && from && to) {
      const t = new Date(o[key]).getTime();
      if (t < new Date(from).getTime() || t > new Date(to).getTime()) return false;
    }
    return true;
  });
}

function opName(q: string) {
  return /(query|mutation)\s+(\w+)/.exec(q)?.[2] ?? "anon";
}

const admin = {
  async graphql(query: string, opts?: { variables?: Record<string, unknown> }) {
    const v = opts?.variables ?? {};
    const name = opName(query);
    let data: unknown = {};
    if (name === "SettlementOrders") {
      const all = searchOrders(String(v.query ?? ""));
      const start = v.after ? Number(v.after) : 0;
      const first = Number(v.first ?? 100);
      const nodes = all.slice(start, start + first);
      const next = start + first < all.length;
      data = { orders: { nodes, pageInfo: { hasNextPage: next, endCursor: next ? String(start + first) : null } } };
    } else if (name === "ShopTimezone") {
      data = { shop: { ianaTimezone: "Asia/Tokyo" } };
    } else if (/locations\s*\(/.test(query)) {
      data = {
        locations: {
          nodes: [
            { id: STORE_A, name: STORE_A_NAME, isActive: true },
            { id: STORE_B, name: STORE_B_NAME, isActive: true },
          ],
        },
      };
    } else if (/plan\s*\{/.test(query)) {
      data = { shop: { plan: { partnerDevelopment: false } } };
    }
    return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
  },
};

(globalThis as any).__ssTestAuthenticateAdmin = async () => ({ admin, session: { shop: SHOP_DOMAIN } });

// ---------------------------------------------------------------------------
// DB の初期状態
// ---------------------------------------------------------------------------

type RefundMode = "order_transaction" | "refund_transaction_pos_location";
type FallbackMode = "order_retail_location" | "exclude";

function resetDb(settlement: { refundAggregationLocationMode: RefundMode; nonPosRefundFallbackMode: FallbackMode }) {
  for (const k of Object.keys(store)) delete store[k];
  store.shop = [{ id: SHOP_ID, shopDomain: SHOP_DOMAIN, shopifyShopGid: "gid://shopify/Shop/1", planCode: "pro" }];
  store.appSetting = [
    { shopId: SHOP_ID, key: "general_settings", valueJson: JSON.stringify({ defaultTimezone: "Asia/Tokyo" }) },
    {
      shopId: SHOP_ID,
      key: "settlement_settings",
      valueJson: JSON.stringify({ legacyGiftCardAggregationEnabled: false, ...settlement }),
    },
  ];
  store.location = [
    { id: "loc_a", shopId: SHOP_ID, shopifyLocationGid: STORE_A, name: STORE_A_NAME, salesSummaryEnabled: true, nonPosRefundAttributionEnabled: false },
    { id: "loc_b", shopId: SHOP_ID, shopifyLocationGid: STORE_B, name: STORE_B_NAME, salesSummaryEnabled: true, nonPosRefundAttributionEnabled: false },
  ];
}

// ---------------------------------------------------------------------------
// 読み込み（DB の偽物を置いたあと）
// ---------------------------------------------------------------------------

type Engine = typeof import("./settlementEngine.server");
type Summary = typeof import("./salesSummaryEngine.server");
type DailyPayload = typeof import("./salesSummaryDailyPayload.server");
let engine: Engine;
let summary: Summary;
let dailyPayload: DailyPayload;

before(async () => {
  engine = await import("./settlementEngine.server");
  summary = await import("./salesSummaryEngine.server");
  dailyPayload = await import("./salesSummaryDailyPayload.server");
});

const STORES = [
  { gid: STORE_A, name: STORE_A_NAME },
  { gid: STORE_B, name: STORE_B_NAME },
] as const;

async function previewOf(loc: { gid: string; name: string }) {
  return engine.buildSettlementPreview(admin, SHOP_ID, loc.gid, loc.name, DAY);
}

// ---------------------------------------------------------------------------
// 1 + 2. 売上サマリー ＝ 精算プレビュー（返金の計上店の設定 4 通り）
// ---------------------------------------------------------------------------

/**
 * 設定ごとの期待値（手計算）。税込の総売上 total で書く（純売上は total を税 10% で割り戻した値）。
 * - 本店の売上: 3300 + 5500 + 2200 + 6600 = 17600。駅前店の売上: 11000
 * - 1004 の返金 2200（駅前店の POS）: order_transaction → 本店（retailLocation 優先）、
 *   refund_transaction_pos_location → 駅前店
 * - 1005 の返金 1100（管理画面・場所なし）: order_retail_location → 本店、exclude → どこにも数えない
 */
const CASES: {
  refundAggregationLocationMode: RefundMode;
  nonPosRefundFallbackMode: FallbackMode;
  expectTotal: Record<string, number>;
}[] = [
  { refundAggregationLocationMode: "order_transaction", nonPosRefundFallbackMode: "order_retail_location", expectTotal: { [STORE_A]: 17600 - 2200 - 1100, [STORE_B]: 11000 } },
  { refundAggregationLocationMode: "order_transaction", nonPosRefundFallbackMode: "exclude", expectTotal: { [STORE_A]: 17600 - 2200, [STORE_B]: 11000 } },
  { refundAggregationLocationMode: "refund_transaction_pos_location", nonPosRefundFallbackMode: "order_retail_location", expectTotal: { [STORE_A]: 17600 - 1100, [STORE_B]: 11000 - 2200 } },
  { refundAggregationLocationMode: "refund_transaction_pos_location", nonPosRefundFallbackMode: "exclude", expectTotal: { [STORE_A]: 17600, [STORE_B]: 11000 - 2200 } },
];

for (const c of CASES) {
  describe(`売上サマリーと精算の整合（${c.refundAggregationLocationMode} / ${c.nonPosRefundFallbackMode}）`, () => {
    it("精算プレビューの総売上が手計算の期待値になる（設定が効いている）", async () => {
      resetDb(c);
      for (const loc of STORES) {
        const p = await previewOf(loc);
        assert.equal(p.total, c.expectTotal[loc.gid], `${loc.name} の total`);
        const split = engine.splitTaxInclusiveToNetAndTax(c.expectTotal[loc.gid], 10);
        assert.equal(p.netSales, split.netSales, `${loc.name} の netSales`);
      }
    });

    it("computeAndCacheDailySummary の actual・件数・点数 ＝ 精算プレビュー、キャッシュも同じ", async () => {
      resetDb(c);
      for (const loc of STORES) {
        const p = await previewOf(loc);
        const row = await summary.computeAndCacheDailySummary(admin, SHOP_ID, loc.gid, loc.name, DAY);
        assert.equal(row.actual, p.netSales, `${loc.name} の actual`);
        assert.equal(row.orders, p.orderCount, `${loc.name} の orders`);
        assert.equal(row.items, p.itemCount, `${loc.name} の items`);
        const cached = store.salesSummaryCacheDaily.find((r) => r.locationId === loc.gid && r.targetDate === DAY);
        assert.ok(cached, `${loc.name} のキャッシュがある`);
        assert.equal(cached.actual, p.netSales);
        assert.equal(cached.orders, p.orderCount);
        assert.equal(cached.items, p.itemCount);
      }
    });

    it("日次ペイロード（計算し直し・キャッシュ読み）の店ごとの値と合計 ＝ 精算プレビュー", async () => {
      resetDb(c);
      const previews = new Map<string, Awaited<ReturnType<typeof previewOf>>>();
      for (const loc of STORES) previews.set(loc.gid, await previewOf(loc));
      const sumNet = [...previews.values()].reduce((s, p) => s + p.netSales, 0);
      const sumOrders = [...previews.values()].reduce((s, p) => s + p.orderCount, 0);
      const sumItems = [...previews.values()].reduce((s, p) => s + p.itemCount, 0);

      // 1 回目: 計算し直し（キャッシュを作る）、2 回目: 過去日なのでキャッシュから読む
      for (const forceRecompute of [true, false]) {
        const payload = await dailyPayload.buildDailySalesSummaryPayload(admin, { id: SHOP_ID }, { targetDate: DAY, forceRecompute });
        assert.equal(payload.rows.length, STORES.length, "両店の行がある");
        for (const row of payload.rows) {
          const p = previews.get(row.locationId);
          assert.ok(p, `精算プレビューのある店: ${row.locationId}`);
          assert.equal(row.actual, p.netSales, `${row.locationName} の actual（forceRecompute=${forceRecompute}）`);
          assert.equal(row.orders, p.orderCount);
          assert.equal(row.items, p.itemCount);
        }
        assert.equal(payload.totals.actual, sumNet, `合計の actual（forceRecompute=${forceRecompute}）`);
        assert.equal(payload.totals.orders, sumOrders);
        assert.equal(payload.totals.items, sumItems);
      }
    });
  });
}

describe("売上サマリーと精算の整合（設定どうしの比べ合い）", () => {
  it("返金の行き先が変わっても、両店の総売上の和は fallback の設定だけで決まる", async () => {
    const sums: Record<string, number> = {};
    for (const c of CASES) {
      resetDb(c);
      let s = 0;
      for (const loc of STORES) s += (await previewOf(loc)).total;
      sums[`${c.refundAggregationLocationMode}/${c.nonPosRefundFallbackMode}`] = s;
    }
    assert.equal(sums["order_transaction/order_retail_location"], sums["refund_transaction_pos_location/order_retail_location"]);
    assert.equal(sums["order_transaction/exclude"], sums["refund_transaction_pos_location/exclude"]);
    assert.equal(sums["order_transaction/exclude"] - sums["order_transaction/order_retail_location"], 1100);
  });
});

// ---------------------------------------------------------------------------
// 3. 予算 CSV の読み取り（管理画面 /app/budget-management の取り込み）
// ---------------------------------------------------------------------------

describe("予算 CSV の読み取り", () => {
  type BudgetRoute = typeof import("../routes/app.budget-management");
  let route: BudgetRoute;
  before(async () => {
    route = await import("../routes/app.budget-management");
  });

  async function importCsv(text: string) {
    const req = new Request("https://app.test/app/budget-management", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: text,
    });
    const res = (await route.action({ request: req, params: {}, context: {} } as any)) as Response;
    return (await res.json()) as { ok: boolean; inserted: number; updated: number; skipped: number; errors: string[] };
  }

  const budgetOf = (loc: string, date: string) =>
    store.budget?.find((b) => b.shopId === SHOP_ID && b.locationId === loc && b.targetDate === date)?.amount;

  it("日本語ヘッダー（ダウンロードのひな形）: BOM・CRLF・¥ とカンマ・引用符・全角空白の店名を読む", async () => {
    resetDb(CASES[0]);
    const csv =
      "﻿ロケーション名,日付,予算\r\n" +
      `${STORE_A_NAME},${DAY},"¥20,000"\r\n` +
      `　${STORE_B_NAME}　,${DAY},12000\r\n` +
      `${STORE_A_NAME},${DAY_PREV},\r\n` + // 金額空欄は飛ばす
      `知らない店,${DAY},5000\r\n`;
    const r = await importCsv(csv);
    assert.equal(r.ok, true);
    assert.equal(r.inserted, 2);
    assert.equal(r.updated, 0);
    assert.equal(r.skipped, 1);
    assert.equal(budgetOf(STORE_A, DAY), 20000);
    assert.equal(budgetOf(STORE_B, DAY), 12000);
    assert.equal(budgetOf(STORE_A, DAY_PREV), undefined);
    assert.ok(r.errors.some((e) => e.includes("知らない店")), "知らない店はエラーに出る");
  });

  it("旧ヘッダー（locationId,targetDate,amount）: 数値 ID を GID にし、同じ店・日は上書き", async () => {
    resetDb(CASES[0]);
    const first = await importCsv(`locationId,targetDate,amount\n100,${DAY},15000\n${STORE_B},${DAY},8000\n`);
    assert.equal(first.inserted, 2);
    assert.equal(budgetOf(STORE_A, DAY), 15000);
    assert.equal(budgetOf(STORE_B, DAY), 8000);
    const second = await importCsv(`locationId,targetDate,amount\n100,${DAY},16000\n`);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 1);
    assert.equal(budgetOf(STORE_A, DAY), 16000);
  });

  it("取り込んだ予算が売上サマリーの予算・予算比（＝ 精算の純売上 ÷ 予算）に出る", async () => {
    resetDb(CASES[0]);
    await importCsv(`ロケーション名,日付,予算\n${STORE_A_NAME},${DAY},"20,000"\n${STORE_B_NAME},${DAY},12000\n`);
    const budgets = { [STORE_A]: 20000, [STORE_B]: 12000 };
    for (const loc of STORES) {
      const p = await previewOf(loc);
      const row = await summary.computeAndCacheDailySummary(admin, SHOP_ID, loc.gid, loc.name, DAY);
      assert.equal(row.budget, budgets[loc.gid]);
      assert.equal(row.budgetRatio, p.netSales / budgets[loc.gid]);
    }
    const payload = await dailyPayload.buildDailySalesSummaryPayload(admin, { id: SHOP_ID }, { targetDate: DAY });
    assert.equal(payload.totals.budget, 32000);
  });
});
