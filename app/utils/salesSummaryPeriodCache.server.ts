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

/**
 * POS の期間（当月）の読み込みで、1 回のリクエストの中で数えてよい時間（ミリ秒）。
 * 環境変数 SALES_SUMMARY_POS_PERIOD_TIME_BUDGET_MS（0=制限なし、未設定時は 20 秒）。
 * 時間を超えた「店×日」は裏で数える（salesSummaryFillQueue）。POS の待ち時間を超えて切れないため。
 */
export function getSalesSummaryPosPeriodTimeBudgetMs(): number {
  return parseEnvIntWithZeroUnlimited("SALES_SUMMARY_POS_PERIOD_TIME_BUDGET_MS", 20000, 1000, 600000);
}

/**
 * 数えるのに失敗した「店×日」を少しのあいだ覚え、開くたびに同じ分を数え直さない。
 * 覚える時間は SALES_SUMMARY_COMPUTE_FAILURE_TTL_SECONDS（未設定時は 10 分）。
 */
const failedComputes = new Map<string, number>();
const FAILED_MAX_ENTRIES = 5000;

function failureTtlMs(): number {
  const raw = Number(process.env.SALES_SUMMARY_COMPUTE_FAILURE_TTL_SECONDS);
  const sec = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 600;
  return sec * 1000;
}

export function markSalesSummaryComputeFailed(key: string, now = Date.now()): void {
  const ttl = failureTtlMs();
  if (ttl <= 0) return;
  failedComputes.set(key, now + ttl);
  while (failedComputes.size > FAILED_MAX_ENTRIES) {
    const first = failedComputes.keys().next().value;
    if (first === undefined) break;
    failedComputes.delete(first);
  }
}

export function isSalesSummaryComputeRecentlyFailed(key: string, now = Date.now()): boolean {
  const until = failedComputes.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    failedComputes.delete(key);
    return false;
  }
  return true;
}

export function clearSalesSummaryComputeFailed(key: string): void {
  failedComputes.delete(key);
}

/** 試験用 */
export function __resetSalesSummaryComputeFailuresForTest() {
  failedComputes.clear();
}

/** ログに出す失敗の理由（長さを切る。個人情報は入れない前提のエラー文だけ） */
export function computeFailureReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").slice(0, 200);
}
