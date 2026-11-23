/**
 * 売上サマリーの裏の再計算（orders/updated Webhook のキュー）を、同じ店・同じ日の分でまとめる。
 *
 * 考え方: ある日の再計算が「ジョブが積まれたあと」に始まり、失敗なく終わっていれば、
 * その再計算は Shopify をジョブより新しい時点で読んでいる。だからそのジョブの日は
 * もう一度数え直さなくても同じ数字になる（数え方は変えない。数え直す回数だけ減る）。
 *
 * Webhook が続けて届くと、前はジョブ 1 件ごとに全店・全チャネルを数え直し、
 * 裏の処理が何分も詰まって画面の集計を待たせていた。
 *
 * 覚えておくのはこのプロセスの中だけ（再起動で消える。消えたときは前と同じく数え直すだけ）。
 */

/** `${shopId}|${date}` → その日の再計算が失敗なく終わったうち、いちばん新しい開始時刻 */
const coveredSince = new Map<string, number>();
const MAX_KEYS = 5000;

function key(shopId: string, date: string): string {
  return `${shopId}|${date}`;
}

/**
 * jobCreatedAt より後に始まって失敗なく終わった再計算がある日を除いた日付を返す。
 * jobCreatedAt が無いとき（同期の Webhook など）は全部返す。
 */
export function datesStillNeedingRefresh(
  shopId: string,
  targetDates: string[],
  jobCreatedAt: Date | null | undefined,
): string[] {
  if (!jobCreatedAt) return [...targetDates];
  const created = jobCreatedAt.getTime();
  if (!Number.isFinite(created)) return [...targetDates];
  return targetDates.filter((d) => {
    const at = coveredSince.get(key(shopId, d));
    return !(at !== undefined && at > created);
  });
}

/** 再計算が失敗なく終わった日を、開始時刻とともに覚える */
export function markRefreshCompleted(shopId: string, dates: string[], startedAt: Date): void {
  const t = startedAt.getTime();
  for (const d of dates) {
    const k = key(shopId, d);
    const prev = coveredSince.get(k);
    if (prev === undefined || t > prev) {
      coveredSince.delete(k);
      coveredSince.set(k, t);
    }
  }
  while (coveredSince.size > MAX_KEYS) {
    const oldest = coveredSince.keys().next().value;
    if (oldest === undefined) break;
    coveredSince.delete(oldest);
  }
}

/** 試験用 */
export function resetRefreshCoalesceForTest(): void {
  coveredSince.clear();
}
