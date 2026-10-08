/**
 * 支払方法マスタのマッチング（一覧・同期・精算表示で共有）
 * Prisma 型に依存しない純ロジックはユニットテスト可能。
 */

export type PaymentMethodMatchInput = {
  rawGatewayPattern: string;
  formattedGatewayPattern?: string | null;
  matchType: string;
  displayLabel: string;
  isVoucher?: boolean;
  voucherChangeSupported?: boolean;
  enabled?: boolean;
};

/** ASCII gateway → 既定日本語（マスタ未登録時） */
export const PAYMENT_METHOD_FALLBACK_LABELS: Record<string, string> = {
  cash: "現金",
  shopify_payments: "クレジットカード",
  bogus: "クレジットカード（テスト）",
  gift_card: "ギフトカード",
  manual: "手動決済",
  "": "その他",
};

export function matchesGatewayPattern(
  value: string,
  pattern: string,
  matchType: string,
): boolean {
  const v = (value ?? "").toLowerCase();
  const p = (pattern ?? "").toLowerCase();
  if (!p) return false;
  if (matchType === "exact_match") return v === p;
  if (matchType === "starts_with_match") return v.startsWith(p);
  return v.includes(p); // contains_match
}

/**
 * gateway（raw / GAS 日本語バケットキー / formatted）に一致するマスタを返す。
 * 一致候補: rawGatewayPattern / formattedGatewayPattern / displayLabel（完全一致）
 */
export function matchPaymentMethodMaster<T extends PaymentMethodMatchInput>(
  gateway: string,
  masters: T[],
): T | null {
  const key = String(gateway ?? "").trim();
  if (!key) return null;

  for (const m of masters) {
    if (m.enabled === false) continue;
    const rawMatch = matchesGatewayPattern(key, m.rawGatewayPattern, m.matchType);
    const fmtMatch = m.formattedGatewayPattern
      ? matchesGatewayPattern(key, m.formattedGatewayPattern, m.matchType)
      : false;
    const labelMatch =
      String(m.displayLabel ?? "")
        .trim()
        .toLowerCase() === key.toLowerCase();
    if (rawMatch || fmtMatch || labelMatch) return m;
  }
  return null;
}

/**
 * 精算 payment section の表示ラベルを解決する。
 * 集計キー（gasNormalizeGatewayLabel 結果）でもマスタ差し替え可能。
 */
export function resolvePaymentSectionLabel(
  bucketKey: string,
  masters: PaymentMethodMatchInput[],
): string {
  const key = String(bucketKey ?? "").trim();
  const matched = matchPaymentMethodMaster(key, masters);
  if (matched?.displayLabel) return matched.displayLabel;
  return PAYMENT_METHOD_FALLBACK_LABELS[key] ?? (key || "その他");
}

export function hasVoucherLikeGatewayHeuristic(
  gateways: string[],
  masters: PaymentMethodMatchInput[],
): boolean {
  if (gateways.some((g) => /gift|voucher|商品券|ギフト/i.test(g))) return true;
  return gateways.some((g) => matchPaymentMethodMaster(g, masters)?.isVoucher === true);
}
