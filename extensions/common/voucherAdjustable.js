/**
 * 商品券釣銭調整を登録できる注文か（POS の行・画面で同じ判定を使う。T のカード 2026-11-24「釣有りの会計だけ押せる」）
 * - 「商品券釣有り」: 支払方法マスタの釣り有りの商品券で払った、またはメモに「商品券」（サーバーの estimatedVoucherChange）
 * - 支払いが 1 件も読めない注文は判定できないので、押せるままにする（注文の詳細の画面と同じ）
 */
export function isVoucherAdjustableOrder(order) {
  if (!order) return false;
  if (order.estimatedVoucherChange) return true;
  return (order.transactions ?? []).length === 0;
}

/** その注文に有効な商品券釣銭調整がもうあるか（あれば登録の画面ではなく調整履歴を出す） */
export function hasActiveVoucherAdjustment(events) {
  return (events ?? []).some((e) => e?.eventType === "voucher_change_adjustment" && e?.status === "active");
}

/**
 * 取引詳細・会計後の「商品券釣銭調整」から開いたときに、どの画面を出すか
 * @returns {"form_voucher" | "order_detail_registered" | "order_detail_not_voucher"}
 */
export function voucherShortcutStep(order, events) {
  if (hasActiveVoucherAdjustment(events)) return "order_detail_registered";
  if (!isVoucherAdjustableOrder(order)) return "order_detail_not_voucher";
  return "form_voucher";
}
