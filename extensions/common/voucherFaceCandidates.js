/**
 * 商品券の額面の候補（T 2026-11-24）: 払った額（または会計の合計）より大きい切りのいい額を 3 つ。
 * 1 つ目は一番近い 100 円区切り、残りはその次に近い 500 円区切り。
 * 例: 2,230 → 2,300・2,500・3,000。2,300（ちょうど 100 の倍数）→ 2,400・2,500・3,000。
 * 100 円区切りが 500 の倍数と重なるとき（2,430 → 2,500）は、次の 500 円区切りで埋める（2,500・3,000・3,500）。
 */
export function voucherFaceCandidates(amount, { count = 3 } = {}) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return [];
  const first = Math.floor(n / 100) * 100 + 100;
  const list = [first];
  let next = Math.floor(first / 500) * 500 + 500;
  while (list.length < count) {
    list.push(next);
    next += 500;
  }
  return list;
}
