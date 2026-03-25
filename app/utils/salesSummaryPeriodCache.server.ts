/**
 * 売上サマリー「期間」表示向け: 日次キャッシュの有無判定と、1リクエストあたりの計算上限。
 * 管理画面・POS 期間 API で共通利用。
 */

function parseEnvIntWithZeroUnlimited(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i === 0) return 0;
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** 環境変数 SALES_SUMMARY_PERIOD_MAX_COMPUTES（0=無制限、未設定時は 48） */
export function getSalesSummaryPeriodMaxComputes(): number {
  return parseEnvIntWithZeroUnlimited("SALES_SUMMARY_PERIOD_MAX_COMPUTES", 48, 1, 500);
}

export function buildLocationDayCacheSet<T extends { shopifyLocationGid: string }>(
  rows: Array<{ locationId: string; targetDate: string }>,
  targetLocations: T[],
  resolveCanonicalLocationGid: (targetLocations: T[], rowLocationId: string) => string | null,
): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    const canon = resolveCanonicalLocationGid(targetLocations, r.locationId);
    if (!canon) continue;
    set.add(`${canon}|${r.targetDate}`);
  }
  return set;
}

/** 過去日はキャッシュがあれば再計算しない。当日以降は常に再計算対象。 */
export function needsLocationDayCompute(
  day: string,
  locGid: string,
  today: string,
  cacheSet: Set<string>,
): boolean {
  const hasCache = cacheSet.has(`${locGid}|${day}`);
  const shouldRecompute = day >= today;
  if (!shouldRecompute && hasCache) return false;
  return true;
}
