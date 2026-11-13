/**
 * 精算・チャネル集計で共有する税の純関数（DB / Shopify 非依存）。
 *
 * 業務上の正（印字・精算プレビューの tax / netSales）は設定税率％による税込逆算。
 * Shopify 注文税の按分値（taxShopify / taxTotalShopify）は診断用で、本モジュールの対象外。
 */

/**
 * 税込の合計金額から税抜純売上と内税相当額を算出する。
 * buildSettlementPreview の netSales / tax と同一の式（精算設定の税率％を税込ベースから逆算）。
 */
export function splitTaxInclusiveToNetAndTax(
  inclusiveTotal: number,
  taxRatePercent: number,
): { netSales: number; tax: number } {
  const roundInt = (n: number) => Math.round(n);
  const total = Math.max(0, inclusiveTotal);
  const tax = roundInt((total * taxRatePercent) / (100 + taxRatePercent));
  const netSales = roundInt(total - tax);
  return { netSales, tax };
}
