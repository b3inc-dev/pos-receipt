/**
 * 決済会社の支払いを別の手段で返したとき、Shopify では返金しない（二重に返さない）判定の試験
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processorRefundMismatchReason } from "./shopifyRefundExecute.server";

const card = { id: "t1", kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", manualPaymentGateway: false };
const cash = { id: "t2", kind: "SALE", status: "SUCCESS", gateway: "cash", manualPaymentGateway: true };
const points = { id: "t3", kind: "SALE", status: "SUCCESS", gateway: "施設ポイント", manualPaymentGateway: true };
const otherProcessor = { id: "t4", kind: "SALE", status: "SUCCESS", gateway: "paypal", manualPaymentGateway: false };

describe("processorRefundMismatchReason", () => {
  it("カード払い（Shopify Payments）を現金で返したら止める", () => {
    assert.ok(processorRefundMismatchReason([card], "payment_method_override", "cash"));
  });
  it("現金返金の種別で手段が空でも、カード払いなら止める", () => {
    assert.ok(processorRefundMismatchReason([card], "cash_refund", null));
  });
  it("manualPaymentGateway が無くても名前が shopify_payments なら止める", () => {
    const { manualPaymentGateway: _omit, ...noFlag } = card;
    assert.ok(processorRefundMismatchReason([noFlag], "payment_method_override", "cash"));
  });
  it("ほかの決済会社（手動でない）も別の手段なら止める", () => {
    assert.ok(processorRefundMismatchReason([otherProcessor], "payment_method_override", "cash"));
  });
  it("カード払いをカードで返すときは止めない", () => {
    assert.equal(processorRefundMismatchReason([card], "payment_method_override", "shopify_payments"), null);
  });
  it("現金やカスタム決済の支払いは止めない（お金は動かない）", () => {
    assert.equal(processorRefundMismatchReason([cash], "payment_method_override", "施設ポイント"), null);
    assert.equal(processorRefundMismatchReason([points], "cash_refund", "cash"), null);
    assert.equal(
      processorRefundMismatchReason([{ ...cash, manualPaymentGateway: false }], "payment_method_override", "施設ポイント"),
      null,
    );
  });
  it("実際の手段が分からない付け替えは今までどおり（止めない）", () => {
    assert.equal(processorRefundMismatchReason([card], "payment_method_override", ""), null);
  });
  it("返金先にカードが 1 つでも混ざり、手段が違えば止める", () => {
    assert.ok(processorRefundMismatchReason([cash, card], "cash_refund", "cash"));
  });
});
