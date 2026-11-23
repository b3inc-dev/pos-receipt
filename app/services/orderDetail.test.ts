/**
 * 注文詳細（POS の注文詳細・会計やり直しの下書き）のクエリと整形。
 * LineItem.staffMember など read_users が要る項目をクエリに入れると、
 * read_users の無い店（公開用・自社用とも）では ACCESS_DENIED で注文の取得ごと 500 になる。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ORDER_DETAIL_QUERY, serializeOrderDetail } from "./orderDetail.server";

describe("ORDER_DETAIL_QUERY", () => {
  it("read_users が要るスタッフの項目を読まない", () => {
    assert.doesNotMatch(ORDER_DETAIL_QUERY, /staffMember/i);
    assert.doesNotMatch(ORDER_DETAIL_QUERY, /StaffMember/);
    assert.doesNotMatch(ORDER_DETAIL_QUERY, /attributedStaff/i);
  });

  it("明細・決済・返金は今までどおり読む", () => {
    for (const field of ["lineItems(first: 100)", "transactions(first: 50)", "refunds", "customAttributes", "discountAllocations"]) {
      assert.ok(ORDER_DETAIL_QUERY.includes(field), field);
    }
  });
});

describe("serializeOrderDetail", () => {
  const order = {
    id: "gid://shopify/Order/123",
    name: "#1001",
    createdAt: "2026-11-23T01:00:00Z",
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          title: "シャツ",
          name: "シャツ - M",
          quantity: 2,
          sku: "SKU1",
          variant: { id: "gid://shopify/ProductVariant/9" },
          refundableQuantity: 2,
          originalUnitPriceSet: { shopMoney: { amount: "1000", currencyCode: "JPY" } },
          discountedUnitPriceSet: { shopMoney: { amount: "900", currencyCode: "JPY" } },
          customAttributes: [],
          discountAllocations: [],
          taxLines: [],
        },
      ],
    },
    transactions: [],
    refunds: [],
  };

  it("スタッフが無くても明細を返し、販売スタッフ名は空にする", () => {
    const out = serializeOrderDetail(order) as { lineItems: Record<string, unknown>[] };
    assert.equal(out.lineItems.length, 1);
    const li = out.lineItems[0];
    assert.equal(li.title, "シャツ");
    assert.equal(li.variantTitle, "M");
    assert.equal(li.lineTotal, "1800");
    assert.equal(li.staffMemberName, "");
  });
});

describe("applyPaymentDisplayLabels", () => {
  const masters = [
    { rawGatewayPattern: "wespo", matchType: "contains_match", displayLabel: "WeSPOポイント", enabled: true },
  ];

  it("支払方法マスタの名前 → 既定の日本語 → Shopify の名前 の順。gateway は変えない", async () => {
    const { applyPaymentDisplayLabels } = await import("./orderDetail.server");
    const out = applyPaymentDisplayLabels(
      {
        transactions: [
          { gateway: "cash", formattedGateway: "Cash", displayName: "Cash", amount: 3325 },
          { gateway: "wespo-point", formattedGateway: "wespo-point", displayName: "wespo-point", amount: 100 },
          { gateway: "odd_pay", formattedGateway: "Odd Pay", displayName: "Odd Pay", amount: 1 },
        ],
        refunds: [{ id: "r1", transactions: [{ gateway: "cash", formattedGateway: "Cash", displayName: "Cash", amount: 1100 }] }],
      },
      masters,
    );
    const txs = out.transactions as { gateway: string; displayName: string }[];
    assert.deepEqual(txs.map((t) => t.displayName), ["現金", "WeSPOポイント", "Odd Pay"]);
    assert.deepEqual(txs.map((t) => t.gateway), ["cash", "wespo-point", "odd_pay"]);
    const refunds = out.refunds as { id: string; transactions: { displayName: string }[] }[];
    assert.equal(refunds[0].id, "r1");
    assert.equal(refunds[0].transactions[0].displayName, "現金");
  });
});
