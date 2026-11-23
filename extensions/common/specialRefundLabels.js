/**
 * 特殊返金・商品券調整の種類を、店の人が読む名前にする（cash_refund などの生の表記を画面に出さない）。
 * 名前は特殊返金の画面（SpecialRefundModal.jsx の EVENT_TYPE_LABELS）と同じ。
 */
export const SPECIAL_REFUND_EVENT_TYPE_LABELS = {
  cash_refund: "現金返金",
  payment_method_override: "返金手段変更",
  receipt_cash_adjustment: "レシートの現金を直す",
  voucher_change_adjustment: "商品券調整",
};

/** 知らない種類は「特殊返金」とだけ出す */
export function specialRefundEventTypeLabel(eventType) {
  const k = String(eventType ?? "").trim();
  return SPECIAL_REFUND_EVENT_TYPE_LABELS[k] ?? "特殊返金";
}
