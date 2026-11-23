/**
 * POS の登録画面に出す「元の支払い」（extensions/common/orderTenderLines.js）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderTenderLines,
  fullAmountForRefund,
  matchMethodValue,
  roundMoney,
  originalMethodChoices,
  defaultOriginalMethod,
} from "../../extensions/common/orderTenderLines.js";

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

test("選択肢の当てはめ: 同じ名前だけ。一部が同じだけのものは当てない", () => {
  const items = [{ value: "cash" }, { value: "shopify_payments" }];
  assert.equal(matchMethodValue(items, "Shopify_Payments"), "shopify_payments");
  assert.equal(matchMethodValue(items, "cash_on_delivery"), null);
  assert.equal(matchMethodValue([{ value: "cashless" }], "cash"), null);
  assert.equal(matchMethodValue(items, "paypay"), null);
  assert.equal(matchMethodValue(items, ""), null);
});

test("端数のある通貨でも全額反映で切り捨てない", () => {
  const lines = orderTenderLines({
    transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "cash", displayName: "Cash", amount: "12.34" }],
    refunds: [{ transactions: [{ gateway: "cash", amount: "5.5" }] }],
  });
  assert.deepEqual(lines.map((l: { paid: number; refunded: number }) => [l.paid, l.refunded]), [[12.34, 5.5]]);
  assert.equal(fullAmountForRefund(lines[0]), 5.5);
  assert.equal(roundMoney("1000"), 1000);
});

test("元の支払手段: この注文で払われた支払方法だけ。初めは返金のある方法、無ければ多く払った方法", () => {
  const lines = orderTenderLines(order);
  assert.deepEqual(originalMethodChoices(lines), [
    { value: "商品券", label: "商品券" },
    { value: "shopify_payments", label: "クレジット" },
  ]);
  assert.equal(defaultOriginalMethod(lines), "shopify_payments");
  const single = orderTenderLines({ transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "cash", displayName: "現金", amount: "3325" }] });
  assert.deepEqual(originalMethodChoices(single), [{ value: "cash", label: "現金" }]);
  assert.equal(defaultOriginalMethod(single), "cash");
  assert.deepEqual(originalMethodChoices([]), []);
  assert.equal(defaultOriginalMethod([]), null);
});
