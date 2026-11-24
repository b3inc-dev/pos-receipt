/**
 * orders/updated の同期（syncRefundAggregationMetafieldForOrder）が、特殊返金を登録した店の metafield を
 * 売った店へ書き戻さないこと（#119 見直し P2-A）。そのあと精算の集計に通して、返金した店で 1 回だけ数えることも見る。
 * （Prisma・設定・Shopify GraphQL・metafield の書き込みだけ差し替える。npm test が --experimental-test-module-mocks を付ける）
 */
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { RefundAggregationContext } from "./refundAggregationPure.server";

const L = (n: number) => `gid://shopify/Location/${n}`;
const ORDER = "gid://shopify/Order/7001";
const SHOP = "shop1";

type Ev = { locationId: string; shopifyRefundId: string | null; createdAt: Date };
let events: Ev[] = [];
let lastEventWhere: any = null;
let settings: Record<string, unknown> = {};
let nonPosTarget: string | null = null;
let shopifyOrder: any = null;
const writes: Array<{ orderId: string; gid: string | null }> = [];

const prismaMock = {
  specialRefundEvent: {
    findMany: async (args: any) => {
      lastEventWhere = args.where;
      return events;
    },
  },
  location: {
    findFirst: async () => (nonPosTarget ? { shopifyLocationGid: nonPosTarget } : null),
  },
};

mock.module(new URL("../db.server.ts", import.meta.url).href, { defaultExport: prismaMock });
mock.module(new URL("../utils/appSettings.server.ts", import.meta.url).href, {
  namedExports: {
    getAppSetting: async () => settings,
    SETTLEMENT_SETTINGS_KEY: "settlement_settings",
    DEFAULT_SETTLEMENT_SETTINGS: {
      refundAggregationLocationMode: "order_transaction",
      nonPosRefundFallbackMode: "order_retail_location",
    },
  },
});
mock.module(new URL("../lib/shopifyGraphqlThrottle.server.ts", import.meta.url).href, {
  namedExports: {
    adminGraphqlWithRetry: async () => ({ data: { order: shopifyOrder } }),
  },
});
mock.module(new URL("./posOrderMetafields.server.ts", import.meta.url).href, {
  namedExports: {
    setOrderRefundAggregationLocationGid: async (_a: unknown, orderId: string, gid: string | null) => {
      writes.push({ orderId, gid });
    },
  },
});

const { syncRefundAggregationMetafieldForOrder } = await import("./refundAggregation.server.ts");
const { aggregateGasStyleForOrders, mergeCrossLocationRefundOrders } = await import(
  "./settlementAggregatePure.server.ts"
);

const admin = { graphql: async () => ({ json: async () => ({}) }) };
const money = (a: number) => ({ shopMoney: { amount: String(a), currencyCode: "JPY" } });

/** 店 100 で 1000 円売った注文。refunds は [id, 店 or null, 時刻] */
function setOrder(refunds: Array<[string, number | null, string]>) {
  shopifyOrder = {
    id: ORDER,
    retailLocation: { id: L(100) },
    transactions: [
      { id: "sale", kind: "SALE", createdAt: "2026-11-24T01:00:00Z", location: { id: L(100) } },
      ...refunds.map(([id, loc, at]) => ({
        id: `tx-${id}`,
        kind: "REFUND",
        createdAt: at,
        location: loc ? { id: L(loc) } : null,
      })),
    ],
    refunds: refunds.map(([id, loc, at]) => ({
      id: `gid://shopify/Refund/${id}`,
      createdAt: at,
      transactions: { nodes: [{ id: `tx-${id}`, kind: "REFUND", location: loc ? { id: L(loc) } : null }] },
    })),
  };
}

beforeEach(() => {
  events = [];
  lastEventWhere = null;
  settings = { refundAggregationLocationMode: "refund_transaction_pos_location" };
  nonPosTarget = null;
  writes.length = 0;
});

async function syncedGid(): Promise<string | null> {
  writes.length = 0;
  await syncRefundAggregationMetafieldForOrder(admin, SHOP, ORDER);
  assert.equal(writes.length, 1);
  return writes[0].gid;
}

describe("orders/updated の同期: 特殊返金を登録した店を残す（P2-A）", () => {
  it("店 200 で登録した特殊返金（Shopify の返金に店なし）: metafield は店 200 のまま（売った店 100 に戻さない）", async () => {
    setOrder([["1", null, "2026-11-24T03:00:00Z"]]);
    events = [{ locationId: L(200), shopifyRefundId: "gid://shopify/Refund/1", createdAt: new Date() }];
    assert.equal(await syncedGid(), L(200));
  });

  it("特殊返金が無い注文（管理画面の返金）: 今までどおり売った店 100", async () => {
    setOrder([["1", null, "2026-11-24T03:00:00Z"]]);
    assert.equal(await syncedGid(), L(100));
  });

  it("特殊返金が無い注文で「POS 以外の返金の計上先」がある: 今までどおりその店", async () => {
    setOrder([["1", null, "2026-11-24T03:00:00Z"]]);
    nonPosTarget = L(300);
    assert.equal(await syncedGid(), L(300));
  });

  it("特殊返金のあとに管理画面で返金した（最後の店なしの返金は特殊返金ではない）: 今までどおり売った店 100", async () => {
    setOrder([
      ["1", null, "2026-11-24T03:00:00Z"],
      ["2", null, "2026-11-24T05:00:00Z"],
    ]);
    events = [{ locationId: L(200), shopifyRefundId: "gid://shopify/Refund/1", createdAt: new Date() }];
    assert.equal(await syncedGid(), L(100));
  });

  it("特殊返金のあとに店 300 で POS 返品（店付き）: 店の付かない返金は特殊返金だけなので店 200", async () => {
    setOrder([
      ["1", null, "2026-11-24T03:00:00Z"],
      ["2", 300, "2026-11-24T05:00:00Z"],
    ]);
    events = [{ locationId: L(200), shopifyRefundId: "gid://shopify/Refund/1", createdAt: new Date() }];
    assert.equal(await syncedGid(), L(200));
  });

  it("POS の返品だけ（店付き）: 今までどおり（返金基準は返品した店 300）", async () => {
    setOrder([["2", 300, "2026-11-24T05:00:00Z"]]);
    events = [{ locationId: L(200), shopifyRefundId: "gid://shopify/Refund/9", createdAt: new Date() }];
    assert.equal(await syncedGid(), L(300));
  });

  it("注文基準（売った店で数える）でも、特殊返金を登録した店を残す（精算の数え方は注文基準のまま変わらない）", async () => {
    settings = { refundAggregationLocationMode: "order_transaction" };
    setOrder([["1", null, "2026-11-24T03:00:00Z"]]);
    events = [{ locationId: L(200), shopifyRefundId: "1", createdAt: new Date() }];
    assert.equal(await syncedGid(), L(200));
  });

  it("特殊返金の照会は Shopify で返金した行だけ・純正の返金の付け替えは外す", async () => {
    setOrder([["1", null, "2026-11-24T03:00:00Z"]]);
    await syncedGid();
    assert.equal(lastEventWhere.shopId, SHOP);
    assert.deepEqual(lastEventWhere.sourceOrderId, { in: [ORDER, "7001"] });
    assert.equal(lastEventWhere.shopifyRefundStatus, "success");
    assert.deepEqual(lastEventWhere.shopifyRefundId, { not: null });
    assert.deepEqual(lastEventWhere.OR, [{ refundSource: null }, { refundSource: { not: "native" } }]);
  });

  it("同期のあとの精算（返金基準）: 返金は店 200 で 1 回、売った店 100 は売上だけ", async () => {
    setOrder([["1", null, "2026-11-24T03:00:00Z"]]);
    events = [{ locationId: L(200), shopifyRefundId: "gid://shopify/Refund/1", createdAt: new Date() }];
    const mf = await syncedGid();
    const order = {
      id: ORDER,
      note: null,
      cancelledAt: null,
      totalPriceSet: money(1000),
      totalTaxSet: { shopMoney: { amount: "0" } },
      lineItems: { nodes: [{ quantity: 1 }] },
      retailLocation: { id: L(100) },
      refundAggregationLocationGid: mf,
      transactions: [
        { id: "sale", createdAt: "2026-11-24T01:00:00Z", kind: "SALE", amountSet: money(1000), gateway: "cash", location: { id: L(100) } },
        { id: "tx-1", createdAt: "2026-11-24T03:00:00Z", kind: "REFUND", amountSet: money(300), gateway: "cash" },
      ],
      refunds: [
        {
          createdAt: "2026-11-24T03:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [{ id: "tx-1", kind: "REFUND", amountSet: money(300), gateway: "cash" }],
        },
      ],
    };
    const ctx: RefundAggregationContext = {
      mode: "refund_transaction_pos_location",
      nonPosRefundFallbackMode: "order_retail_location",
      nonPosRefundTargetLocationGid: null,
    };
    const inDay = (iso?: string) => !!iso && iso.startsWith("2026-11-24");
    const result: Record<number, { sale: number; refund: number }> = {};
    for (const s of [100, 200]) {
      const merged = mergeCrossLocationRefundOrders(s === 100 ? [order] : [], [order], inDay, L(s), String(s), ctx);
      const gas = aggregateGasStyleForOrders(merged, inDay, {
        attributionCtx: ctx,
        settlementLocationId: L(s),
        locIdRaw: String(s),
      });
      result[s] = { sale: gas.pay["現金"]?.sale ?? 0, refund: gas.pay["現金"]?.refund ?? 0 };
    }
    assert.deepEqual(result[100], { sale: 1000, refund: 0 });
    assert.deepEqual(result[200], { sale: 0, refund: 300 });
  });
});
