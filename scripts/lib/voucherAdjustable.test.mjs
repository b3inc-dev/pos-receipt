import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasActiveVoucherAdjustment,
  isVoucherAdjustableOrder,
  voucherShortcutStep,
} from "../../extensions/common/voucherAdjustable.js";

test("商品券釣有りの注文だけ押せる（支払いが読めない注文は押せるまま）", () => {
  assert.equal(isVoucherAdjustableOrder({ estimatedVoucherChange: 340, transactions: [{}] }), true);
  assert.equal(isVoucherAdjustableOrder({ estimatedVoucherChange: null, transactions: [{ gateway: "cash" }] }), false);
  assert.equal(isVoucherAdjustableOrder({ transactions: [] }), true);
  assert.equal(isVoucherAdjustableOrder(null), false);
});

test("有効な商品券釣銭登録があるか（無効にしたもの・ほかの種類は数えない）", () => {
  assert.equal(hasActiveVoucherAdjustment([{ eventType: "voucher_change_adjustment", status: "active" }]), true);
  assert.equal(hasActiveVoucherAdjustment([{ eventType: "voucher_change_adjustment", status: "voided" }]), false);
  assert.equal(hasActiveVoucherAdjustment([{ eventType: "cash_refund", status: "active" }]), false);
  assert.equal(hasActiveVoucherAdjustment(undefined), false);
});

test("行から開いたとき: 登録済み → 調整履歴、釣有りでない → 案内、釣有りで未登録 → 登録の画面", () => {
  const voucher = { estimatedVoucherChange: 340, transactions: [{}] };
  const cash = { estimatedVoucherChange: null, transactions: [{}] };
  const reg = [{ eventType: "voucher_change_adjustment", status: "active" }];
  assert.equal(voucherShortcutStep(voucher, reg), "order_detail_registered");
  assert.equal(voucherShortcutStep(voucher, []), "form_voucher");
  assert.equal(voucherShortcutStep(cash, []), "order_detail_not_voucher");
});
