import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  eventTypeNeedsRefundMethod,
  findSelectableRefundMethod,
  refundMethodNotInMasterMessage,
} from "./specialRefundMethodValidation";

const selectable = [
  { rawGatewayPattern: "cash", displayLabel: "現金" },
  { rawGatewayPattern: "Lumine Point", displayLabel: "ルミネポイント" },
];

describe("特殊返金の返金手段はマスタからだけ", () => {
  it("返金手段を選ぶ種別", () => {
    assert.equal(eventTypeNeedsRefundMethod("cash_refund"), true);
    assert.equal(eventTypeNeedsRefundMethod("payment_method_override"), true);
    assert.equal(eventTypeNeedsRefundMethod("receipt_cash_adjustment"), false);
    assert.equal(eventTypeNeedsRefundMethod("voucher_change_adjustment"), false);
  });
  it("マスタの値（大文字小文字・空白の違いは同じ）を受ける", () => {
    assert.equal(findSelectableRefundMethod("cash", selectable)?.displayLabel, "現金");
    assert.equal(findSelectableRefundMethod(" lumine point ", selectable)?.displayLabel, "ルミネポイント");
  });
  it("マスタに無い・空・表示名だけは受けない", () => {
    assert.equal(findSelectableRefundMethod("facility_point", selectable), null);
    assert.equal(findSelectableRefundMethod("", selectable), null);
    assert.equal(findSelectableRefundMethod(null, selectable), null);
    assert.equal(findSelectableRefundMethod("ルミネポイント", selectable), null);
  });
  it("文言", () => {
    assert.match(refundMethodNotInMasterMessage("facility_point"), /facility_point.*支払方法/);
    assert.match(refundMethodNotInMasterMessage(""), /選んでください/);
  });
});
