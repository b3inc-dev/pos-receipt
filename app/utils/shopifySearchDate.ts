/**
 * Shopify Admin の検索文（orders / giftCards の query）に日時の条件を書く。
 *
 * 値は必ず二重引用符で囲む。開発ストア（2026-11-23）で確かめたこと:
 * - created_at:>=2026-11-19T15:00:00Z（引用符なし）は時刻が効かず、範囲より前の
 *   2026-11-19T08:57:49Z の注文が返った。created_at:>="2026-11-19T15:00:00Z" なら返らない。
 * - created_at:>=2026-11-23T00:00:00+09:00（引用符なし）は同日の注文を取りこぼした。
 * Shopify 側でどう読まれているか（時刻が落ちる・「+」が空白になる等）は未確認。
 * 日時は UTC の Z 表記で渡す（getDayRangeInUtc / getDayRangeShopifySearchIso）。
 */

/** 検索文に入れてよい日時か（引用符・空白・バックスラッシュを含まない） */
function assertSafeSearchDate(iso: string): string {
  const v = String(iso ?? "").trim();
  if (!v || /["\\\s]/.test(v)) {
    throw new Error(`Invalid search date: ${JSON.stringify(iso)}`);
  }
  return v;
}

/** 例: searchDateCondition("created_at", ">=", "2026-11-22T15:00:00Z") → created_at:>="2026-11-22T15:00:00Z" */
export function searchDateCondition(
  field: string,
  op: ">=" | "<=" | ">" | "<",
  iso: string,
): string {
  return `${field}:${op}"${assertSafeSearchDate(iso)}"`;
}

/** その範囲（両端を含む）の条件 2 つを空白でつないで返す */
export function searchDateRange(field: string, startIso: string, endIso: string): string {
  return `${searchDateCondition(field, ">=", startIso)} ${searchDateCondition(field, "<=", endIso)}`;
}
