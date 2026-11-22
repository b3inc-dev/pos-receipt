/**
 * 売上に含めない手数料の明細（`_lsi_fee="1"` かつ `_lsi_fee_sales="0"`）の見分け方と、
 * 精算集計（aggregateGasStyleForOrders）・領収書の金額・保存済み精算の印字での扱い。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNonSalesFeeLine,
  nonSalesFeeForOrder,
  nonSalesFeeTotalFromSaved,
  receiptAmountExcludingNonSalesFees,
} from "./nonSalesFeeLines";
import {
  aggregateGasStyleForOrders,
  totalFromPayBuckets,
  type GasStyleOrder,
} from "./settlementAggregatePure.server";

const DAY1 = "2026-11-23T01:00:00Z";
const DAY2 = "2026-11-24T01:00:00Z";
const inDay1 = (iso?: string) => Boolean(iso && iso.startsWith("2026-11-23"));
const inDay2 = (iso?: string) => Boolean(iso && iso.startsWith("2026-11-24"));

function money(amount: number | string) {
  return { shopMoney: { amount: String(amount), currencyCode: "JPY" } };
}

function feeAttrs(sales: "0" | "1" | null) {
  const a = [{ key: "_lsi_fee", value: "1" }];
  if (sales !== null) a.push({ key: "_lsi_fee_sales", value: sales });
  a.push({ key: "_lsi_fee_points", value: "0" });
  return a;
}

/** 商品 1,000 円 × 2 点 ＋ 送料 500 円（税込）を現金で払った注文 */
function orderWithFee(
  sales: "0" | "1" | null,
  extra: Partial<GasStyleOrder> = {},
  goodsDiscount = 0,
  feeDiscount = 0,
): GasStyleOrder {
  const total = 2000 - goodsDiscount + 500 - feeDiscount;
  return {
    id: "gid://shopify/Order/1",
    note: null,
    cancelledAt: null,
    totalPriceSet: money(total),
    currentTotalTaxSet: { shopMoney: { amount: String(Math.round(total / 11)) } },
    taxesIncluded: true,
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/10",
          quantity: 2,
          customAttributes: [],
          originalTotalSet: money(2000),
          taxLines: [{ priceSet: money(182) }],
          discountAllocations: goodsDiscount
            ? [
                {
                  allocatedAmountSet: money(goodsDiscount),
                  discountApplication: { __typename: "ManualDiscountApplication", title: "セール" },
                },
              ]
            : [],
        },
        {
          id: "gid://shopify/LineItem/11",
          quantity: 1,
          customAttributes: feeAttrs(sales),
          originalTotalSet: money(500),
          taxLines: [{ priceSet: money(45) }],
          discountAllocations: feeDiscount
            ? [
                {
                  allocatedAmountSet: money(feeDiscount),
                  discountApplication: { __typename: "ManualDiscountApplication", title: "セール" },
                },
              ]
            : [],
        },
      ],
    },
    transactions: [
      { id: "tx-sale", createdAt: DAY1, kind: "SALE", amountSet: money(total), gateway: "cash" },
    ],
    refunds: [],
    retailLocation: { id: "gid://shopify/Location/100" },
    ...extra,
  };
}

describe("isNonSalesFeeLine（見分け方）", () => {
  it("_lsi_fee=1 かつ _lsi_fee_sales=0 だけを売上外にする", () => {
    assert.equal(isNonSalesFeeLine({ customAttributes: feeAttrs("0") }), true);
    assert.equal(isNonSalesFeeLine({ customAttributes: feeAttrs("1") }), false);
    assert.equal(isNonSalesFeeLine({ customAttributes: feeAttrs(null) }), false);
    assert.equal(isNonSalesFeeLine({ customAttributes: [{ key: "_lsi_fee_sales", value: "0" }] }), false);
    assert.equal(isNonSalesFeeLine({ customAttributes: [] }), false);
    assert.equal(isNonSalesFeeLine({}), false);
  });

  it("名前（「送料」）では見分けない", () => {
    assert.equal(
      isNonSalesFeeLine({ customAttributes: [{ key: "title", value: "送料" }] }),
      false,
    );
  });
});

describe("aggregateGasStyleForOrders — 売上に含めない送料の行", () => {
  it("_lsi_fee_sales=0: 支払方法別はそのまま、送料を nonSalesFeeTotal に分け、点数から外す", () => {
    const gas = aggregateGasStyleForOrders([orderWithFee("0")], inDay1);
    assert.equal(gas.pay["現金"].sale, 2500);
    assert.equal(totalFromPayBuckets(gas.pay), 2500);
    assert.equal(gas.nonSalesFeeTotal, 500);
    assert.equal(gas.itemCount, 2);
    assert.equal(gas.saleOrderSet.size, 1);
    // 総売上（settlementEngine の式）= 支払方法別の合計 − 売上外の送料
    assert.equal(totalFromPayBuckets(gas.pay) - gas.nonSalesFeeTotal, 2000);
    // 税（Shopify 値）から送料の税を引く: round(2500/11)=227 − 45
    assert.equal(gas.taxTotalShopify, 227 - 45);
  });

  it("_lsi_fee_sales=1: 今までどおり売上・点数に含める", () => {
    const gas = aggregateGasStyleForOrders([orderWithFee("1")], inDay1);
    assert.equal(totalFromPayBuckets(gas.pay), 2500);
    assert.equal(gas.nonSalesFeeTotal, 0);
    assert.equal(gas.itemCount, 3);
    assert.equal(gas.taxTotalShopify, 227);
  });

  it("_lsi_fee が無い注文（前の注文）は今までどおり", () => {
    const o = orderWithFee(null);
    o.lineItems!.nodes[1].customAttributes = [];
    const gas = aggregateGasStyleForOrders([o], inDay1);
    assert.equal(gas.nonSalesFeeTotal, 0);
    assert.equal(gas.itemCount, 3);
  });

  it("送料の行に配られた割引は割引に数えず、送料は割引後の金額で外す", () => {
    const gas = aggregateGasStyleForOrders([orderWithFee("0", {}, 200, 50)], inDay1);
    assert.equal(totalFromPayBuckets(gas.pay), 2250);
    assert.equal(gas.discountsTotal, 200);
    assert.equal(gas.nonSalesFeeTotal, 450);
  });

  it("あとの日に送料の行を返金: その日の売上外の送料はマイナス（売上を減らさない）、点数も減らさない", () => {
    const o = orderWithFee("0", {
      transactions: [
        { id: "tx-sale", createdAt: DAY1, kind: "SALE", amountSet: money(2500), gateway: "cash" },
        { id: "tx-ref", createdAt: DAY2, kind: "REFUND", amountSet: money(500), gateway: "cash" },
      ],
      refunds: [
        {
          createdAt: DAY2,
          refundLineItems: [
            {
              quantity: 1,
              lineItem: { id: "gid://shopify/LineItem/11" },
              subtotalSet: money(500),
              totalTaxSet: money(45),
            },
          ],
          transactions: [
            { id: "tx-ref", kind: "REFUND", gateway: "cash", amountSet: money(500) },
          ],
        },
      ],
    });
    const gas = aggregateGasStyleForOrders([o], inDay2);
    assert.equal(totalFromPayBuckets(gas.pay), -500);
    assert.equal(gas.nonSalesFeeTotal, -500);
    assert.equal(totalFromPayBuckets(gas.pay) - gas.nonSalesFeeTotal, 0);
    assert.equal(gas.itemCount, 0);
  });

  it("商品と送料を同じ日に返金: 商品の点数だけ減らす", () => {
    const o = orderWithFee("0", {
      transactions: [
        { id: "tx-sale", createdAt: DAY1, kind: "SALE", amountSet: money(2500), gateway: "cash" },
        { id: "tx-ref", createdAt: DAY1, kind: "REFUND", amountSet: money(1500), gateway: "cash" },
      ],
      refunds: [
        {
          createdAt: DAY1,
          refundLineItems: [
            { quantity: 1, lineItem: { id: "gid://shopify/LineItem/10" }, subtotalSet: money(1000) },
            { quantity: 1, lineItem: { id: "gid://shopify/LineItem/11" }, subtotalSet: money(500) },
          ],
          transactions: [{ id: "tx-ref", kind: "REFUND", gateway: "cash", amountSet: money(1500) }],
        },
      ],
    });
    const gas = aggregateGasStyleForOrders([o], inDay1);
    assert.equal(totalFromPayBuckets(gas.pay), 1000);
    assert.equal(gas.nonSalesFeeTotal, 0);
    assert.equal(totalFromPayBuckets(gas.pay) - gas.nonSalesFeeTotal, 1000);
    assert.equal(gas.itemCount, 1);
  });

  it("税抜価格の店（taxesIncluded=false）は送料の税も合わせて外す", () => {
    const o = orderWithFee("0", { taxesIncluded: false, totalPriceSet: money(2750) });
    o.transactions![0].amountSet = money(2750);
    const gas = aggregateGasStyleForOrders([o], inDay1);
    assert.equal(gas.nonSalesFeeTotal, 545);
  });
});

describe("領収書の金額", () => {
  it("_lsi_fee_sales=0 の送料を引く", () => {
    assert.equal(receiptAmountExcludingNonSalesFees(orderWithFee("0")), 2000);
    assert.deepEqual(nonSalesFeeForOrder(orderWithFee("0")), { amount: 500, tax: 45, quantity: 1 });
  });
  it("_lsi_fee_sales=1・印なしは注文の合計のまま", () => {
    assert.equal(receiptAmountExcludingNonSalesFees(orderWithFee("1")), 2500);
    assert.equal(receiptAmountExcludingNonSalesFees(orderWithFee(null)), 2500);
  });
  it("明細を取れなかった注文は注文の合計のまま", () => {
    assert.equal(receiptAmountExcludingNonSalesFees({ totalPriceSet: money(1234) }), 1234);
  });
});

describe("nonSalesFeeTotalFromSaved（保存済み精算の印字）", () => {
  it("支払方法別の合計 − 総売上", () => {
    assert.equal(nonSalesFeeTotalFromSaved(2000, [{ net: 2500, refund: 0 }]), 500);
    assert.equal(nonSalesFeeTotalFromSaved(2000, [{ net: 1500, refund: 0 }, { net: 500, refund: 0 }]), 0);
  });
  it("丸めの ±1 は送料とみなさない（前からの精算）", () => {
    assert.equal(nonSalesFeeTotalFromSaved(1001, [{ net: 500, refund: 0 }, { net: 500, refund: 0 }]), 0);
  });
  it("総売上 0 の日は 0（戻せない）", () => {
    assert.equal(nonSalesFeeTotalFromSaved(0, [{ net: 0, refund: 500 }]), 0);
  });
});
