/**
 * 特殊返金の Shopify 返金が pending（結果が分かっていない）の登録を、同じ登録のまま確かめ直すための純関数。
 *
 * 登録の ID は `pos_sr_<冪等キー>`（app/services/specialRefundIdempotency.server.ts）。
 * 同じキー・同じ内容で POST /api/special-refunds に送ると、API は既存の pending の登録を続きから処理する。
 * サーバーはまず注文の返金ノートの印 `[POS_RECEIPT_EVENT:<キー>]` を探し、あれば成功として記録するだけ。
 * 無ければ同じキーで refundCreate（@idempotent）を呼ぶ。どちらでも返金は 2 回にならない。
 * 画面を閉じたあとに「登録し直す」と新しいキーになり、返金が 2 回になることがあるので、こちらを使う。
 */

export const POS_SPECIAL_REFUND_EVENT_ID_PREFIX = "pos_sr_";

/** この登録を同じキーで確かめ直せるか */
export function canRecheckShopifyRefund(event) {
  if (!event || event.status === "voided") return false;
  if (String(event.shopifyRefundStatus ?? "").trim().toLowerCase() !== "pending") return false;
  const id = String(event.id ?? "");
  return id.startsWith(POS_SPECIAL_REFUND_EVENT_ID_PREFIX) &&
    id.length > POS_SPECIAL_REFUND_EVENT_ID_PREFIX.length;
}

/**
 * 前からある登録（ID が `pos_sr_` で始まらない）が pending のまま残っているか。
 * この登録は同じキーで送り直せないので、POST /api/special-refunds/:id/recheck で
 * Shopify の返金を読み直して決める（サーバーは返金を実行しない。読むだけ）。
 */
export function canRecheckLegacyShopifyRefund(event) {
  if (!event || event.status === "voided") return false;
  if (String(event.shopifyRefundStatus ?? "").trim().toLowerCase() !== "pending") return false;
  const id = String(event.id ?? "");
  return id.length > 0 && !id.startsWith(POS_SPECIAL_REFUND_EVENT_ID_PREFIX);
}

function numOrNull(v) {
  if (v == null || String(v).trim() === "") return null;
  return Number(v);
}

/** 確かめ直しの送信内容。登録したときと同じ内容（API の冪等の照合に合わせる） */
export function buildShopifyRefundRecheckRequest(event) {
  if (!canRecheckShopifyRefund(event)) return null;
  return {
    idempotencyKey: String(event.id).slice(POS_SPECIAL_REFUND_EVENT_ID_PREFIX.length),
    sourceOrderId: event.sourceOrderId,
    sourceOrderName: event.sourceOrderName ?? null,
    locationId: event.locationId ?? "",
    eventType: event.eventType,
    amount: Number(event.amount),
    currency: event.currency ?? "JPY",
    originalPaymentMethod: event.originalPaymentMethod ?? null,
    actualRefundMethod: event.actualRefundMethod ?? null,
    adjustKind: event.adjustKind ?? null,
    note: event.note ?? null,
    voucherFaceValue: numOrNull(event.voucherFaceValue),
    voucherAppliedAmount: numOrNull(event.voucherAppliedAmount),
    voucherChangeAmount: numOrNull(event.voucherChangeAmount),
    createdBy: event.createdBy ?? null,
  };
}
