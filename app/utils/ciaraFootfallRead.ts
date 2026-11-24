/** ciara-system が読みにくる入店数の範囲（両端を含む。62 日まで） */
export const FOOTFALL_READ_MAX_DAYS = 62;

export function footfallReadDateRange(
  from: string | null,
  to: string | null,
): { ok: true; from: string; to: string } | { ok: false; error: string } {
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !ymd.test(from) || !ymd.test(to)) return { ok: false, error: "from と to は YYYY-MM-DD で指定してください" };
  const a = new Date(`${from}T00:00:00.000Z`);
  const b = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a.toISOString().slice(0, 10) !== from || b.toISOString().slice(0, 10) !== to) {
    return { ok: false, error: "日付が正しくありません" };
  }
  if (b < a) return { ok: false, error: "to は from より後にしてください" };
  if ((b.getTime() - a.getTime()) / 86_400_000 + 1 > FOOTFALL_READ_MAX_DAYS) {
    return { ok: false, error: `1 回に読めるのは ${FOOTFALL_READ_MAX_DAYS} 日までです` };
  }
  return { ok: true, from, to };
}
