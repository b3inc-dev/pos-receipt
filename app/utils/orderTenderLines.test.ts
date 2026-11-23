/**
 * POS の登録画面に出す「元の支払い」（extensions/common/orderTenderLines.js）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderTenderLines, fullAmountForRefund, matchMethodValue } from "../../extensions/common/orderTenderLines.js";

const order = {
  transactions: [
    { kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", displayName: "クレジット", amount: "3000.00" },
    { kind: "SALE", status: "SUCCESS", gateway: "商品券", displayName: "商品券", amount: "5000" },
    { kind: "SALE", status: "FAILURE", gateway: "cash", displayName: "現金", amount: "9999" },
    { kind: "SALE", status: "SUCCESS", gateway: "Shopify_Payments", displayName: "クレジット", amount: "500" },
  ],
  refunds: [{ transactions: [{ gateway: "shopify_payments", displayName: "クレジット", amount: "1200" }] }],
};

test("支払方法ごとにまとめ、失敗した取引は数えない。返金した額も出す", () => {
  const lines = orderTenderLines(order);
  assert.deepEqual(
    lines.map((l: { label: string; paid: number; refunded: number }) => [l.label, l.paid, l.refunded]),
    [
      ["商品券", 5000, 0],
      ["クレジット", 3500, 1200],
    ],
  );
});

test("全額反映: 返金した額があればそれ、無ければ支払った額", () => {
  assert.equal(fullAmountForRefund({ paid: 3500, refunded: 1200 }), 1200);
  assert.equal(fullAmountForRefund({ paid: 3500, refunded: 0 }), 3500);
  assert.equal(fullAmountForRefund(null), 0);
});

test("選択肢の当てはめ: 同じ名前を先に、無ければ含む名前", () => {
  const items = [{ value: "cash" }, { value: "shopify_payments" }];
  assert.equal(matchMethodValue(items, "Shopify_Payments"), "shopify_payments");
  assert.equal(matchMethodValue(items, "cash_on_delivery"), "cash");
  assert.equal(matchMethodValue(items, "paypay"), null);
  assert.equal(matchMethodValue(items, ""), null);
});
