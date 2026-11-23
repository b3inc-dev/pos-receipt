/**
 * 商品券の額面の候補（T 2026-11-24）: 払った額（または会計の合計）より大きい、500 円刻みの切りのいい額を 3 つ。
 * 例: 2,230 → 2,500・3,000・3,500。ちょうど 500 の倍数（2,500）なら次から（3,000・3,500・4,000）。
 */
export function voucherFaceCandidates(amount, { step = 500, count = 3 } = {}) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return [];
  const first = Math.floor(n / step) * step + step;
  return Array.from({ length: count }, (_, i) => first + step * i);
}
