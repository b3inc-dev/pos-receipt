/**
 * 支払方法マスタのマッチング（一覧・同期で共有）
 */
import type { PaymentMethodMaster } from "@prisma/client";

function matches(value: string, pattern: string, matchType: string): boolean {
  const v = (value ?? "").toLowerCase();
  const p = (pattern ?? "").toLowerCase();
  if (matchType === "exact_match") return v === p;
  if (matchType === "starts_with_match") return v.startsWith(p);
  return v.includes(p);
}

export function matchPaymentMethodMaster(
  gateway: string,
  masters: PaymentMethodMaster[],
): PaymentMethodMaster | null {
  for (const m of masters) {
    const rawMatch = matches(gateway, m.rawGatewayPattern, m.matchType);
    const fmtMatch = m.formattedGatewayPattern
      ? matches(gateway, m.formattedGatewayPattern, m.matchType)
      : false;
    if (rawMatch || fmtMatch) return m;
  }
  return null;
}

export function hasVoucherLikeGatewayHeuristic(
  gateways: string[],
  masters: PaymentMethodMaster[],
): boolean {
  if (gateways.some((g) => /gift|voucher|商品券|ギフト/i.test(g))) return true;
  return gateways.some((g) => matchPaymentMethodMaster(g, masters)?.isVoucher === true);
}
