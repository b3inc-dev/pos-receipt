/**
 * 売上サマリー用の純粋な集計（DB・Prisma なし）。
 * ルートのクライアント側（useMemo 等）からも import 可能にするため .server とは分離。
 */

/**
 * 合計行用: 各行の予算フィールド（budget / budgetTotal など）を足す。
 * null・undefined の行はスキップ。1件でも数値があれば合計を返し、すべて未設定なら null（「-」表示）。
 */
export function sumOptionalBudgetColumn(rows: ReadonlyArray<object>, key: string): number | null {
  let sum = 0;
  let anyPresent = false;
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[key];
    if (v != null) {
      anyPresent = true;
      sum += Number(v);
    }
  }
  return anyPresent ? sum : null;
}
