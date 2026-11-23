/**
 * POS の特殊返金の登録画面: 店の人は「返金の手段を変える」「レシートの現金を直す」から選び、種別は返金手段で決める
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { refundEventTypeFor } from "../../extensions/common/refundModes.js";

const methods = [
  { value: "cash", label: "現金", category: "cash" },
  { value: "facility_points", label: "施設ポイント", category: "other" },
  { value: "genkin", label: "現金（レジ）", category: "cash" },
];

test("返金の手段を変える: 現金で返すなら現金返金、ほかの手段なら返金手段変更", () => {
  assert.equal(refundEventTypeFor("method", "cash", methods, null), "cash_refund");
  assert.equal(refundEventTypeFor("method", "genkin", methods, null), "cash_refund");
  assert.equal(refundEventTypeFor("method", "facility_points", methods, null), "payment_method_override");
});

test("店の設定で使えない種別は、もう一方で登録する", () => {
  assert.equal(refundEventTypeFor("method", "cash", methods, ["payment_method_override"]), "payment_method_override");
  assert.equal(refundEventTypeFor("method", "facility_points", methods, ["cash_refund"]), "cash_refund");
});

test("レシートの現金を直す: レシート現金調整", () => {
  assert.equal(refundEventTypeFor("receipt", "cash", methods, null), "receipt_cash_adjustment");
});
