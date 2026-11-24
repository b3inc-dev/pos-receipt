/**
 * GET /api/receipts/history の入力の読み方（ルートから切り出してテストできるようにした）。
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD で、実在する日付か */
export function isYmd(v: string): boolean {
  if (!YMD.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** 件数は 1〜50（0 や負の数、数字でないときは 20） */
export function parseHistoryLimit(raw: string | null): number {
  const n = parseInt(raw ?? "20", 10);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(50, n);
}
