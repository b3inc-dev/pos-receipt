/**
 * Phase 1 — 精算集計純関数の最小ユニットテスト
 * 対象: 件数・返金帰属ゲート・支払バケット
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateGasStyleForOrders,
  buildCrossLocationRefundOnlyOrder,
  decideRefundAttributionForSettlement,
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
  it("別店舗販売の注文を返金店舗向け入力へ変換しても元売上を混入させない", () => {
    const locA = "gid://shopify/Location/100";
    const locB = "gid://shopify/Location/200";
    const order = saleOrder({
      id: "o-cross-location",
      retailLocation: { id: locA },
      transactions: [
        {
          id: "o-cross-sale",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1000),
          gateway: "cash",
          location: { id: locA },
        },
        {
          id: "o-cross-refund",
          createdAt: "2026-10-08T03:00:00Z",
          kind: "REFUND",
          amountSet: money(300),
          gateway: "cash",
          location: { id: locB },
        },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T03:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [
            {
              id: "o-cross-refund",
              kind: "REFUND",
              amountSet: money(300),
              gateway: "cash",
              location: { id: locB },
            },
          ],
        },
      ],
    });

    const refundOnly = buildCrossLocationRefundOnlyOrder(
      order,
      alwaysInRange,
      locB,
      "200",
      "refund_transaction_pos_location",
    );
    assert.ok(refundOnly);
    assert.deepEqual(refundOnly.transactions?.map((tx) => tx.id), ["o-cross-refund"]);

    const gas = aggregateGasStyleForOrders(
      [refundOnly],
      alwaysInRange,
      attributionOpts(locB, "200"),
    );
    assert.equal(gas.pay["現金"]?.sale ?? 0, 0);
    assert.equal(gas.pay["現金"]?.refund, 300);
    assert.equal(gas.saleOrderSet.size, 0);
    assert.equal(gas.refundOrderSet.size, 1);
    assert.equal(gas.itemCount, -1);
  });

  it("注文基準モードでは別店舗の返金専用入力を生成しない", () => {
    const order = saleOrder({
      id: "o-order-mode-cross-refund",
      retailLocation: { id: locA },
      transactions: [
        {
          id: "o-order-mode-cross-refund-tx",
          createdAt: "2026-10-08T03:00:00Z",
          kind: "REFUND",
          amountSet: money(300),
          gateway: "cash",
          location: { id: locB },
        },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T03:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [
            {
              id: "o-order-mode-cross-refund-tx",
              kind: "REFUND",
              amountSet: money(300),
              gateway: "cash",
              location: { id: locB },
            },
          ],
        },
      ],
    });

    const refundOnly = buildCrossLocationRefundOnlyOrder(
      order,
      alwaysInRange,
      locB,
      "200",
      "order_transaction",
    );

    assert.equal(refundOnly, null);
  });

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

  it("当日返金 TX は注文全体の最新 metafield より優先する", () => {
    // 後日の部分返品で metafield が locA へ変わっても、当日の TX locB を維持する
    const order = saleOrder({
      id: "o4mf",
      lineItems: { nodes: [{ quantity: 2 }] },
      retailLocation: { id: locA },
      refundAggregationLocationGid: locA,
      transactions: [
        {
          id: "o4mf-sale",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1000),
          gateway: "cash",
        },
        {
          id: "o4mf-refund",
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
              id: "o4mf-refund",
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
    assert.equal(gas.refundsGross, 0);
    assert.equal(gas.refundAttributionMismatchCount, 1);
  });

  it("別日・別店舗の部分返品は後続 metafield で過去日の帰属が変わらない", () => {
    const order = saleOrder({
      id: "o-history",
      retailLocation: { id: locA },
      // 注文単位 metafield は後発の店舗Bへ更新済み
      refundAggregationLocationGid: locB,
      transactions: [
        {
          id: "o-history-sale",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1000),
          gateway: "cash",
        },
        {
          id: "o-history-r-a",
          createdAt: "2026-10-08T02:00:00Z",
          kind: "REFUND",
          amountSet: money(300),
          gateway: "cash",
        },
        {
          id: "o-history-r-b",
          createdAt: "2026-10-09T02:00:00Z",
          kind: "REFUND",
          amountSet: money(200),
          gateway: "cash",
        },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T02:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [
            {
              id: "o-history-r-a",
              kind: "REFUND",
              amountSet: money(300),
              gateway: "cash",
              location: { id: locA },
            },
          ],
        },
        {
          createdAt: "2026-10-09T02:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [
            {
              id: "o-history-r-b",
              kind: "REFUND",
              amountSet: money(200),
              gateway: "cash",
              location: { id: locB },
            },
          ],
        },
      ],
    });
    const dayA = (iso?: string) => String(iso ?? "").startsWith("2026-10-08");
    const dayB = (iso?: string) => String(iso ?? "").startsWith("2026-10-09");

    const a = aggregateGasStyleForOrders([order], dayA, attributionOpts(locA, "100"));
    const b = aggregateGasStyleForOrders([order], dayB, attributionOpts(locB, "200"));

    assert.equal(a.refundsGross, 300);
    assert.equal(a.pay["現金"]?.refund, 300);
    assert.equal(b.refundsGross, 200);
    assert.equal(b.pay["現金"]?.refund, 200);
  });

  it("同日・別店舗の部分返品は返金 TX ごとに金額を分ける", () => {
    const order = saleOrder({
      id: "o-same-day-split",
      retailLocation: { id: locA },
      refundAggregationLocationGid: locB,
      transactions: [
        {
          id: "o-same-day-sale",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1000),
          gateway: "cash",
        },
        {
          id: "o-same-day-r-a",
          createdAt: "2026-10-08T02:00:00Z",
          kind: "REFUND",
          amountSet: money(300),
          gateway: "cash",
        },
        {
          id: "o-same-day-r-b",
          createdAt: "2026-10-08T03:00:00Z",
          kind: "REFUND",
          amountSet: money(200),
          gateway: "cash",
        },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T02:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [
            {
              id: "o-same-day-r-a",
              kind: "REFUND",
              amountSet: money(300),
              gateway: "cash",
              location: { id: locA },
            },
          ],
        },
        {
          createdAt: "2026-10-08T03:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [
            {
              id: "o-same-day-r-b",
              kind: "REFUND",
              amountSet: money(200),
              gateway: "cash",
              location: { id: locB },
            },
          ],
        },
      ],
    });

    const a = aggregateGasStyleForOrders([order], alwaysInRange, attributionOpts(locA, "100"));
    const b = aggregateGasStyleForOrders([order], alwaysInRange, attributionOpts(locB, "200"));

    assert.equal(a.refundsGross, 300);
    assert.equal(a.pay["現金"]?.refund, 300);
    assert.equal(a.pay["現金"]?.refundTx, 1);
    assert.equal(b.refundsGross, 200);
    assert.equal(b.pay["現金"]?.refund, 200);
    assert.equal(b.pay["現金"]?.refundTx, 1);
  });

  it("当日 POS 返金 TX が無い場合は処理店舗 metafield を fallback に使う", () => {
    const order = saleOrder({
      id: "o-non-pos",
      retailLocation: { id: locA },
      refundAggregationLocationGid: locB,
      transactions: [
        {
          id: "o-non-pos-refund",
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
              id: "o-non-pos-refund",
              kind: "REFUND",
              amountSet: money(400),
              gateway: "cash",
              location: null,
            },
          ],
        },
      ],
    });
    const gas = aggregateGasStyleForOrders([order], alwaysInRange, attributionOpts(locB, "200"));
    assert.equal(gas.refundsGross, 400);
    assert.equal(gas.pay["現金"]?.refund, 400);
  });

  it("metafield 無しなら従来どおり resolve", () => {
    const order = saleOrder({
      id: "o4resolve",
      retailLocation: { id: locA },
      refundAggregationLocationGid: null,
      transactions: [
        {
          id: "o4r-sale",
          createdAt: "2026-10-08T01:00:00Z",
          kind: "SALE",
          amountSet: money(1000),
          gateway: "cash",
        },
        {
          id: "o4r-refund",
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
              id: "o4r-refund",
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
    assert.equal(gas.refundsGross, 0);
    assert.equal(gas.refundAttributionMismatchCount, 0);
  });

  it("decideRefundAttributionForSettlement は不一致時に当日返金 TX を usedGid にする", () => {
    const order = saleOrder({
      id: "o-dec",
      retailLocation: { id: locA },
      refundAggregationLocationGid: locA,
      refunds: [
        {
          createdAt: "2026-10-08T02:00:00Z",
          transactions: [
            {
              id: "o-dec-r",
              kind: "REFUND",
              location: { id: locB },
            },
          ],
        },
      ],
    });
    const d = decideRefundAttributionForSettlement(
      order,
      alwaysInRange,
      attributionOpts(locA, "100"),
    );
    assert.equal(d.metafieldGid, locA);
    assert.equal(d.resolvedGid, locB);
    assert.equal(d.usedGid, locB);
    assert.equal(d.mismatch, true);
    assert.equal(d.counts, false);
  });
});

describe("aggregateGasStyleForOrders — 注文基準モードの返金帰属", () => {
  const locA = "gid://shopify/Location/100";
  const locB = "gid://shopify/Location/200";
  function orderModeOpts(settlementGid: string, locIdRaw: string): GasAggregateAttributionOpts {
    return {
      attributionCtx: {
        mode: "order_transaction",
        nonPosRefundFallbackMode: "order_retail_location",
        nonPosRefundTargetLocationGid: null,
      },
      settlementLocationId: settlementGid,
      locIdRaw,
    };
  }
  // 店 A で売った注文。店 B で特殊返金を登録したので metafield は B。そのあと店 A でふつうの POS 返品をした
  function returnedAtA(): GasStyleOrder {
    return saleOrder({
      id: "o-order-mode",
      lineItems: { nodes: [{ quantity: 2 }] },
      retailLocation: { id: locA },
      refundAggregationLocationGid: locB,
      transactions: [
        { id: "om-sale", createdAt: "2026-10-08T01:00:00Z", kind: "SALE", amountSet: money(1000), gateway: "cash" },
        { id: "om-refund", createdAt: "2026-10-08T05:00:00Z", kind: "REFUND", amountSet: money(500), gateway: "cash" },
      ],
      refunds: [
        {
          createdAt: "2026-10-08T05:00:00Z",
          refundLineItems: [{ quantity: 1 }],
          transactions: [
            { id: "om-refund", kind: "REFUND", amountSet: money(500), gateway: "cash", location: { id: locA } },
          ],
        },
      ],
    });
  }

  it("特殊返金が metafield を別の店に書き換えても、通常の返品は注文の店 A に載る", () => {
    const gas = aggregateGasStyleForOrders([returnedAtA()], alwaysInRange, orderModeOpts(locA, "100"));
    assert.equal(gas.refundsGross, 500);
    assert.equal(gas.pay["現金"]?.refund, 500);
    assert.equal(gas.refundOrderSet.size, 1);
    assert.equal(gas.itemCount, 1);
    assert.equal(gas.refundAttributionMismatchCount, 1);
  });

  it("metafield の店 B には載らない（二重にならない）", () => {
    const gas = aggregateGasStyleForOrders([returnedAtA()], alwaysInRange, orderModeOpts(locB, "200"));
    assert.equal(gas.refundsGross, 0);
    assert.equal(gas.pay["現金"]?.refund ?? 0, 0);
  });

  it("decideRefundAttributionForSettlement は注文基準で resolve を使う", () => {
    const d = decideRefundAttributionForSettlement(returnedAtA(), alwaysInRange, orderModeOpts(locA, "100"));
    assert.equal(d.metafieldGid, locB);
    assert.equal(d.resolvedGid, locA);
    assert.equal(d.usedGid, locA);
    assert.equal(d.mismatch, true);
    assert.equal(d.counts, true);
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
