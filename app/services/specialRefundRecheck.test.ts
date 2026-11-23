/**
 * pending の特殊返金を同じ登録のまま確かめ直す送信内容（POS: extensions/common/specialRefundRecheck.js）。
 * 合成データのみ。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildShopifyRefundRecheckRequest,
  canRecheckShopifyRefund,
} from "../../extensions/common/specialRefundRecheck.js";
import {
  matchesSpecialRefundIdempotencyPayload,
  specialRefundEventIdFromIdempotencyKey,
} from "./specialRefundIdempotency.server";
import { SpecialRefundPendingError } from "./specialRefundOverlayPure.server";

// list API（serializeEvent）が返す形
const pendingEvent = {
  id: "pos_sr_0123456789abcdef-key",
  sourceOrderId: "gid://shopify/Order/1001",
  sourceOrderName: "#1001",
  locationId: "gid://shopify/Location/200",
  eventType: "cash_refund",
  originalPaymentMethod: "クレジット",
  actualRefundMethod: "現金",
  amount: "1000",
  currency: "JPY",
  voucherFaceValue: null,
  voucherAppliedAmount: null,
  voucherChangeAmount: null,
  adjustKind: null,
  note: "サイズ違い",
  createdBy: null,
  status: "active",
  shopifyRefundStatus: "pending",
};

describe("canRecheckShopifyRefund", () => {
  it("pending で pos_sr_ の登録だけ確かめ直せる", () => {
    assert.equal(canRecheckShopifyRefund(pendingEvent), true);
    assert.equal(canRecheckShopifyRefund({ ...pendingEvent, shopifyRefundStatus: "success" }), false);
    assert.equal(canRecheckShopifyRefund({ ...pendingEvent, shopifyRefundStatus: "failed" }), false);
    assert.equal(canRecheckShopifyRefund({ ...pendingEvent, status: "voided" }), false);
    assert.equal(canRecheckShopifyRefund({ ...pendingEvent, id: "cuid123" }), false);
    assert.equal(canRecheckShopifyRefund(null), false);
  });
});

describe("buildShopifyRefundRecheckRequest", () => {
  it("同じ冪等キー（＝同じ登録 ID）になり、API の内容の照合に通る（新しい登録・新しい返金にならない）", () => {
    const req = buildShopifyRefundRecheckRequest(pendingEvent);
    assert.ok(req);
    assert.equal(req!.idempotencyKey, "0123456789abcdef-key");
    assert.equal(specialRefundEventIdFromIdempotencyKey(req!.idempotencyKey), pendingEvent.id);

    // API が組み立てる idempotencyPayload と同じ作り方で、保存済みの登録と照合する
    const shopId = "shop-1";
    const expected = {
      shopId,
      sourceOrderId: String(req!.sourceOrderId),
      sourceOrderName: req!.sourceOrderName ? String(req!.sourceOrderName) : null,
      locationId: req!.locationId ? String(req!.locationId) : "",
      eventType: String(req!.eventType),
      amount: Number(req!.amount),
      currency: req!.currency ? String(req!.currency) : "JPY",
      originalPaymentMethod: req!.originalPaymentMethod ? String(req!.originalPaymentMethod) : null,
      actualRefundMethod: req!.actualRefundMethod ? String(req!.actualRefundMethod) : null,
      adjustKind: req!.adjustKind ? String(req!.adjustKind) : null,
      note: req!.note ? String(req!.note) : null,
      voucherFaceValue: req!.voucherFaceValue != null ? Number(req!.voucherFaceValue) : null,
      voucherAppliedAmount: req!.voucherAppliedAmount != null ? Number(req!.voucherAppliedAmount) : null,
      voucherChangeAmount: req!.voucherChangeAmount != null ? Number(req!.voucherChangeAmount) : null,
      createdBy: req!.createdBy ? String(req!.createdBy) : null,
    };
    const stored = { ...pendingEvent, shopId, amount: { toString: () => "1000.00" } };
    assert.equal(matchesSpecialRefundIdempotencyPayload(stored, expected), true);
  });

  it("確かめ直せない登録は null", () => {
    assert.equal(buildShopifyRefundRecheckRequest({ ...pendingEvent, shopifyRefundStatus: "success" }), null);
  });
});

describe("精算が止まったときの案内", () => {
  it("Shopify 管理画面で先に確かめ、同じ登録で確かめ直すよう案内する。登録し直し・無効化は勧めない", () => {
    const msg = new SpecialRefundPendingError(["#1001"]).message;
    assert.match(msg, /Shopify の管理画面/);
    assert.match(msg, /「返金を確かめる」/);
    assert.match(msg, /無効化したり、登録し直したりはしないでください/);
    assert.ok(!msg.includes("同じ内容でもう一度実行"));
  });

  it("POS の登録一覧に pending の表示（返金処理中）と確かめ直しのボタン、日別一覧に「返金処理中」がある", () => {
    const modal = readFileSync(new URL("../../extensions/pos-smart-grid/src/SpecialRefundModal.jsx", import.meta.url), "utf8");
    assert.ok(modal.includes("返金処理中（結果待ち。この日の精算が止まります）"));
    assert.ok(modal.includes("返金を確かめる"));
    assert.ok(modal.includes('event?.shopifyRefundStatus === "pending"'));
    const utils = readFileSync(new URL("../../extensions/pos-smart-grid/src/orderDisplayUtils.js", import.meta.url), "utf8");
    assert.ok(utils.includes("返金処理中"));
  });
});
