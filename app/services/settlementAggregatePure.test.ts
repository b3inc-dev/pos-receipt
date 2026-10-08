/**
 * Phase 1 — 精算集計純関数の最小ユニットテスト
 * 対象: 件数・返金帰属ゲート・支払バケット
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateGasStyleForOrders,
  gasNormalizeGatewayLabel,
  totalFromPayBuckets,
  type GasAggregateAttributionOpts,
  type GasStyleOrder,
} from "./settlementAggregatePure.server";
import type { RefundAggregationContext } from "./refundAggregationPure.server";

const alwaysInRange = (_iso?: string) => true;

function money(amount: number | string) {
  return { shopMoney: { amount: String(amount), currencyCode: "JPY" } };
}

function saleOrder(overrides: Partial<GasStyleOrder> & { id: string }): GasStyleOrder {
  return {
    note: null,
    cancelledAt: null,
    totalPriceSet: money(1000),
    totalTaxSet: { shopMoney: { amount: "0" } },
    lineItems: { nodes: [{ quantity: 1 }] },
    transactions: [
      {
        id: `${overrides.id}-sale`,
        createdAt: "2026-10-08T01:00:00Z",
        kind: "SALE",
        amountSet: money(1000),
        gateway: "cash",
      },
    ],
    refunds: [],
    retailLocation: { id: "gid://shopify/Location/100" },
    ...overrides,
  };
}

describe("gasNormalizeGatewayLabel（支払バケットキー）", () => {
  it("現金・クレジット・QR・交通系・商品券・空を正規化する", () => {
    assert.equal(gasNormalizeGatewayLabel("cash"), "現金");
    assert.equal(gasNormalizeGatewayLabel("credit_card"), "クレジットカード");
    assert.equal(gasNormalizeGatewayLabel("shopify_payments", "QR決済"), "電子マネー(QR)");
    assert.equal(gasNormalizeGatewayLabel("suica"), "交通系ICカード決済");
    assert.equal(gasNormalizeGatewayLabel("gift_card"), "商品券");
    assert.equal(gasNormalizeGatewayLabel("gift_card", "釣有り"), "商品券釣有り");
    assert.equal(gasNormalizeGatewayLabel("gift_card", "釣無し"), "商品券釣無し");
    assert.equal(gasNormalizeGatewayLabel(""), "未分類");
  });
});

describe("aggregateGasStyleForOrders — 件数", () => {
  it("売上注文は saleOrderSet に入り、点数は lineItems を加算する", () => {
    const order = saleOrder({
      id: "o1",
      lineItems: { nodes: [{ quantity: 3 }] },
    });
    const gas = aggregateGasStyleForOrders([order], alwaysInRange);
    assert.equal(gas.saleOrderSet.size, 1);
    assert.equal(gas.refundOrderSet.size, 0);
    assert.equal(gas.itemCount, 3);
    assert.equal(gas.pay["現金"]?.sale, 1000);
    assert.equal(gas.pay["現金"]?.saleTx, 1);
  });

  it("同日フル返金は sale に入らず refundOrderSet に入り、点数を差し引く", () => {
    const order = saleOrder({
      id: "o2",
      lineItems: { nodes: [{ quantity: 2 }] },
      transactions: [
        {
          id: "o2-sale",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1000),
          gateway: "cash",
        },
        {
          id: "o2-refund",
          createdAt: "2026-10-08T02:00:00Z",
          kind: "REFUND",
          amountSet: money(1000),
          gateway: "cash",
        },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T02:00:00Z",
          refundLineItems: [{ quantity: 2 }],
          transactions: [
            {
              id: "o2-refund",
              kind: "REFUND",
              amountSet: money(1000),
              gateway: "cash",
            },
          ],
        },
      ],
    });
    const gas = aggregateGasStyleForOrders([order], alwaysInRange);
    assert.equal(gas.saleOrderSet.size, 0);
    assert.equal(gas.refundOrderSet.size, 1);
    assert.equal(gas.itemCount, 0);
    assert.equal(gas.pay["現金"]?.refund, 1000);
    assert.equal(gas.pay["現金"]?.refundTx, 1);
  });

  it("1注文に REFUND TX が2件でも header 返金件数は注文1件、section は refundTx=2", () => {
    const order = saleOrder({
      id: "o3",
      totalPriceSet: money(2000),
      transactions: [
        {
          id: "o3-sale",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(2000),
          gateway: "credit_card",
        },
        {
          id: "o3-r1",
          createdAt: "2026-10-08T02:00:00Z",
          kind: "REFUND",
          amountSet: money(500),
          gateway: "credit_card",
        },
        {
          id: "o3-r2",
          createdAt: "2026-10-08T03:00:00Z",
          kind: "REFUND",
          amountSet: money(500),
          gateway: "credit_card",
        },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T02:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [{ id: "o3-r1", kind: "REFUND", amountSet: money(500), gateway: "credit_card" }],
        },
        {
          createdAt: "2026-10-08T03:00:00Z",
          refundLineItems: [{ quantity: 0 }],
          transactions: [{ id: "o3-r2", kind: "REFUND", amountSet: money(500), gateway: "credit_card" }],
        },
      ],
    });
    const gas = aggregateGasStyleForOrders([order], alwaysInRange);
    assert.equal(gas.refundOrderSet.size, 1);
    assert.equal(gas.pay["クレジットカード"]?.refundTx, 2);
    assert.equal(gas.pay["クレジットカード"]?.refund, 1000);
    assert.equal(gas.saleOrderSet.size, 1);
  });
});

describe("aggregateGasStyleForOrders — 返金帰属", () => {
  const locA = "gid://shopify/Location/100";
  const locB = "gid://shopify/Location/200";

  function attributionOpts(settlementGid: string, locIdRaw: string): GasAggregateAttributionOpts {
    const attributionCtx: RefundAggregationContext = {
      mode: "refund_transaction_pos_location",
      nonPosRefundFallbackMode: "exclude",
      nonPosRefundTargetLocationGid: null,
    };
    return {
      attributionCtx,
      settlementLocationId: settlementGid,
      locIdRaw,
    };
  }

  it("他ロケーションの返金は件数・金額・点数に載せない", () => {
    const order = saleOrder({
      id: "o4",
      lineItems: { nodes: [{ quantity: 2 }] },
      retailLocation: { id: locA },
      transactions: [
        {
          id: "o4-sale",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1000),
          gateway: "cash",
        },
        {
          id: "o4-refund",
          createdAt: "2026-10-08T02:00:00Z",
          kind: "REFUND",
          amountSet: money(400),
          gateway: "cash",
        },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T02:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [
            {
              id: "o4-refund",
              kind: "REFUND",
              amountSet: money(400),
              gateway: "cash",
              location: { id: locB },
            },
          ],
        },
      ],
    });

    const gas = aggregateGasStyleForOrders([order], alwaysInRange, attributionOpts(locA, "100"));
    assert.equal(gas.refundOrderSet.size, 0);
    assert.equal(gas.pay["現金"]?.refund ?? 0, 0);
    assert.equal(gas.itemCount, 2);
    assert.equal(gas.saleOrderSet.size, 1);
    assert.equal(gas.refundsGross, 0);
  });

  it("同一ロケーションの返金は帰属して差し引く", () => {
    const order = saleOrder({
      id: "o5",
      lineItems: { nodes: [{ quantity: 2 }] },
      retailLocation: { id: locA },
      transactions: [
        {
          id: "o5-sale",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1000),
          gateway: "cash",
        },
        {
          id: "o5-refund",
          createdAt: "2026-10-08T02:00:00Z",
          kind: "REFUND",
          amountSet: money(400),
          gateway: "cash",
        },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T02:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [
            {
              id: "o5-refund",
              kind: "REFUND",
              amountSet: money(400),
              gateway: "cash",
              location: { id: locA },
            },
          ],
        },
      ],
    });

    const gas = aggregateGasStyleForOrders([order], alwaysInRange, attributionOpts(locA, "100"));
    assert.equal(gas.refundOrderSet.size, 1);
    assert.equal(gas.pay["現金"]?.refund, 400);
    assert.equal(gas.itemCount, 1);
    assert.equal(gas.refundsGross, 400);
  });
});

describe("aggregateGasStyleForOrders — 支払バケット", () => {
  it("現金キャップ: お釣り分は現金 sale に載せない", () => {
    const order = saleOrder({
      id: "o6",
      totalPriceSet: money(1000),
      transactions: [
        {
          id: "o6-cash",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1500),
          gateway: "cash",
        },
      ],
    });
    const gas = aggregateGasStyleForOrders([order], alwaysInRange);
    assert.equal(gas.pay["現金"]?.sale, 1000);
    assert.equal(totalFromPayBuckets(gas.pay), 1000);
  });

  it("複数ゲートウェイが別バケットに分かれ、totalFromPayBuckets は net 合計", () => {
    const order = saleOrder({
      id: "o7",
      totalPriceSet: money(3000),
      transactions: [
        {
          id: "o7-cash",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1000),
          gateway: "cash",
        },
        {
          id: "o7-card",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(2000),
          gateway: "credit_card",
        },
        {
          id: "o7-refund",
          createdAt: "2026-10-08T02:00:00Z",
          kind: "REFUND",
          amountSet: money(500),
          gateway: "credit_card",
        },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T02:00:00Z",
          transactions: [
            {
              id: "o7-refund",
              kind: "REFUND",
              amountSet: money(500),
              gateway: "credit_card",
            },
          ],
        },
      ],
    });
    const gas = aggregateGasStyleForOrders([order], alwaysInRange);
    assert.equal(gas.pay["現金"]?.sale, 1000);
    assert.equal(gas.pay["クレジットカード"]?.sale, 2000);
    assert.equal(gas.pay["クレジットカード"]?.refund, 500);
    assert.equal(totalFromPayBuckets(gas.pay), 2500);
  });
});
