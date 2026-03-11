/**
 * 支払方法マスタから表示ラベルを解決（要件 §6）
 * 精算レシートの payment sections で使用
 */
import prisma from "../db.server";

const FALLBACK_LABELS: Record<string, string> = {
  cash: "現金",
  shopify_payments: "クレジットカード",
  bogus: "クレジットカード（テスト）",
  gift_card: "ギフトカード",
  manual: "手動決済",
  "": "その他",
};

function matches(
  value: string,
  pattern: string,
  matchType: string
): boolean {
  const v = (value ?? "").toLowerCase();
  const p = (pattern ?? "").toLowerCase();
  if (matchType === "exact_match") return v === p;
  if (matchType === "starts_with_match") return v.startsWith(p);
  return v.includes(p); // contains_match
}

/**
 * ショップの支払方法マスタを取得し、gateway に一致する displayLabel を返す。
 * 複数一致する場合は sortOrder が小さいものを優先。一致なしならフォールバック。
 */
export async function getPaymentMethodDisplayLabel(
  shopId: string,
  gateway: string
): Promise<string> {
  const masters = await prisma.paymentMethodMaster.findMany({
    where: { shopId, enabled: true },
    orderBy: { sortOrder: "asc" },
  });

  for (const m of masters) {
    const rawMatch = matches(gateway, m.rawGatewayPattern, m.matchType);
    const fmtMatch =
      !m.formattedGatewayPattern ||
      matches(gateway, m.formattedGatewayPattern, m.matchType);
    if (rawMatch || fmtMatch) return m.displayLabel;
  }

  return FALLBACK_LABELS[gateway] ?? gateway ?? "その他";
}
