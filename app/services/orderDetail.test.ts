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
