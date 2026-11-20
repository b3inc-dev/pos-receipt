import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchesSpecialRefundIdempotencyPayload,
  specialRefundEventIdFromIdempotencyKey,
  type SpecialRefundIdempotencyPayload,
} from "./specialRefundIdempotency.server";

const payload: SpecialRefundIdempotencyPayload = {
  shopId: "shop-1",
  sourceOrderId: "100",
  sourceOrderName: "#100",
  locationId: "gid://shopify/Location/1",
  eventType: "cash_refund",
  amount: 1000,
  currency: "JPY",
  originalPaymentMethod: "credit_card",
  actualRefundMethod: "cash",
  adjustKind: null,
  note: "reason",
  voucherFaceValue: null,
  voucherAppliedAmount: null,
  voucherChangeAmount: null,
  createdBy: "staff-1",
};

describe("specialRefundEventIdFromIdempotencyKey", () => {
  it("許可文字の十分長いキーを専用主キーへ変換する", () => {
    assert.equal(
      specialRefundEventIdFromIdempotencyKey("123e4567-e89b-12d3-a456-426614174000"),
      "pos_sr_123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("短い・不正文字のキーを拒否する", () => {
    assert.equal(specialRefundEventIdFromIdempotencyKey("short"), null);
    assert.equal(specialRefundEventIdFromIdempotencyKey("invalid key with spaces"), null);
  });
});

describe("matchesSpecialRefundIdempotencyPayload", () => {
  it("同じ操作の再送だけを一致とする", () => {
    assert.equal(matchesSpecialRefundIdempotencyPayload(payload, { ...payload }), true);
    assert.equal(
      matchesSpecialRefundIdempotencyPayload(payload, { ...payload, amount: 1001 }),
      false,
    );
    assert.equal(
      matchesSpecialRefundIdempotencyPayload(payload, {
        ...payload,
        actualRefundMethod: "gift_card",
      }),
      false,
    );
    assert.equal(
      matchesSpecialRefundIdempotencyPayload(payload, {
        ...payload,
        voucherChangeAmount: 100,
      }),
      false,
    );
    assert.equal(
      matchesSpecialRefundIdempotencyPayload(payload, {
        ...payload,
        createdBy: "staff-2",
      }),
      false,
    );
  });
});
