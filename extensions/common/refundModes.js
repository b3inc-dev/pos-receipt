/** 特殊返金の登録画面で店の人が選ぶ内容と、種別の決め方（POS） */

/**
 * 登録画面で店の人が選ぶのは 2 つだけ（T 2026-11-23「3 種類の違いは？」）。
 * 「返金の手段を変える」は、実際の返金手段が現金なら現金返金、それ以外なら返金手段変更として登録する
 * （2 つは精算の数え方・Shopify での返金が同じ。違うのは承認の対象かどうかだけ）。
 */
export const REFUND_MODES = [
  {
    value: "method",
    label: "返金方法を変更する",
    help: "お客様が払った支払方法とは別の返金方法で返したときに使います。例: 施設ポイントで払った分を現金で返した。返金の合計は変わらず、精算の返金方法の内訳だけが移ります。",
  },
  {
    value: "receipt",
    label: "レシートの現金を直す",
    help: "返金ではありません。レシート（Shopify の記録）と実際のレジの現金が合わないときに使います。例: 返金を打ったが、お客様に現金を渡さなかった。Shopify では返金も注文の変更もしません。精算の数字だけが変わります。",
  },
];

export function isCashMethod(value, items) {
  const m = (items ?? []).find((x) => x.value === value);
  return m?.category === "cash" || String(value ?? "").trim().toLowerCase() === "cash";
}

/** 「返金の手段を変える」の種別を、実際の返金手段から決める（店の設定で使えない種別は、もう一方にする） */
export function refundEventTypeFor(mode, actualRefundMethod, refundMethods, allowedEventTypes) {
  if (mode === "receipt") return "receipt_cash_adjustment";
  const allowed = (t) => !allowedEventTypes || allowedEventTypes.includes(t);
  const preferred = isCashMethod(actualRefundMethod, refundMethods) ? "cash_refund" : "payment_method_override";
  const other = preferred === "cash_refund" ? "payment_method_override" : "cash_refund";
  return allowed(preferred) || !allowed(other) ? preferred : other;
}

