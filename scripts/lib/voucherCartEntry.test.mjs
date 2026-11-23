import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VOUCHER_CART_FACE_KEY,
  parseVoucherFaceInput,
  voucherFaceInCart,
  isHintFresh,
  postPurchaseMessage,
} from "../../extensions/common/voucherCartEntry.js";

test("POS と同じキーをサーバーでも使う", async () => {
  const server = await import("../../app/services/voucherCartEntryPure.ts");
  assert.equal(server.VOUCHER_CART_FACE_KEY, VOUCHER_CART_FACE_KEY);
  assert.ok(VOUCHER_CART_FACE_KEY.startsWith("_"), "「_」始まりで POS・レシートに出さない");
  assert.equal(server.parseVoucherCartFace("5,000"), 5000);
  assert.equal(server.parseVoucherCartFace("0"), null);
  assert.equal(server.parseVoucherCartFace("abc"), null);
  assert.equal(
    server.voucherCartFaceFromAttributes([{ key: "x", value: "1" }, { key: VOUCHER_CART_FACE_KEY, value: "3000" }]),
    3000,
  );
  assert.equal(server.voucherCartFaceFromAttributes([]), null);
  assert.equal(server.voucherCartEventId("gid://shopify/Order/123"), "pos_vc_cart_123");
  assert.equal(server.voucherCartEventId("123"), "pos_vc_cart_123");
});

test("額面の入力を読む", () => {
  assert.equal(parseVoucherFaceInput("5000"), 5000);
  assert.equal(parseVoucherFaceInput("5,000円"), 5000);
  assert.equal(parseVoucherFaceInput(""), null);
  assert.equal(parseVoucherFaceInput("-1"), null);
  assert.equal(parseVoucherFaceInput("1e3"), null);
  assert.equal(parseVoucherFaceInput("1000.5"), null, "円なので小数は受けない");
  assert.equal(voucherFaceInCart({ properties: { [VOUCHER_CART_FACE_KEY]: "1000" } }), 1000);
  assert.equal(voucherFaceInCart({ properties: {} }), null);
  assert.equal(voucherFaceInCart(null), null);
});

test("古い目印は使わない", () => {
  const now = 1_000_000_000_000;
  assert.equal(isHintFresh({ at: now - 60_000 }, now), true);
  assert.equal(isHintFresh({ at: now - 13 * 3600_000 }, now), false);
  assert.equal(isHintFresh(null, now), false);
});

test("会計後の一行は店のことばで、生のキーを出さない", () => {
  const created = postPurchaseMessage({ status: "created", event: { voucherFaceValue: 5000, voucherChangeAmount: 700 } });
  assert.equal(created.tone, "success");
  assert.match(created.text, /商品券 5,000円（釣銭 700円）を登録しました/);
  assert.match(postPurchaseMessage({ status: "no_voucher_payment", face: 3000 }).text, /商品券釣有りの支払いが無い/);
  assert.equal(postPurchaseMessage({ status: "no_face" }), null);
  for (const s of ["created", "already", "no_voucher_payment", "face_too_small", "settlement_confirmed", "disabled", "cancelled", "order_unreadable"]) {
    const m = postPurchaseMessage({ status: s, event: {}, face: 1 });
    assert.ok(m && !/_pos_|voucher|釣り/.test(m.text), `${s}: ${m?.text}`);
  }
});
