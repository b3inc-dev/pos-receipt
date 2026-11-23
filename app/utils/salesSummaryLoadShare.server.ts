/**
 * 売上サマリー: 同じ画面の「1 回の読み込み」で同じ計算を二度しないための共有。
 *
 * POS の日次タブは、日次 API と当月の期間 API を同時に呼ぶ。どちらも「今日・その店」を
 * 精算プレビューで数え直すため、同じ問い合わせが 2 回走っていた。
 * 画面が 1 回の読み込みごとに同じ loadId を両方へ付けて送り、サーバーはその loadId の間だけ
 * 計算結果（Promise）を共有する。数え方は変えない（同じ関数を 1 回だけ呼ぶ）。
 *
 * - loadId が無い（古い POS・公開リンク・webhook）ときは共有しない＝今まで通り毎回数える
 * - 「再読み込み」は新しい loadId になるので、必ず数え直す
 * - 失敗した計算は共有から外す（次の呼び出しでやり直す）
 */

const SHARE_TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 2000;

const shared = new Map<string, { promise: Promise<unknown>; expiresAt: number }>();

const LOAD_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** クエリの loadId を検証して返す（不正・未指定は null） */
export function parseSalesSummaryLoadId(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  return LOAD_ID_RE.test(s) ? s : null;
}

function sweep(now: number) {
  for (const [k, v] of shared) {
    if (v.expiresAt <= now) shared.delete(k);
  }
  // 念のため上限を超えたら古い順に捨てる（Map は挿入順）
  while (shared.size > MAX_ENTRIES) {
    const first = shared.keys().next().value;
    if (first === undefined) break;
    shared.delete(first);
  }
}

/**
 * loadId があれば、同じ (loadId, key) の計算を 1 回にまとめる。
 * key には shopId を必ず含めること（他店舗と混ざらないように）。
 */
export function shareWithinLoad<T>(
  loadId: string | null | undefined,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!loadId) return fn();
  const now = Date.now();
  sweep(now);
  const k = `${loadId}|${key}`;
  const hit = shared.get(k);
  if (hit && hit.expiresAt > now) return hit.promise as Promise<T>;
  const promise = fn();
  shared.set(k, { promise, expiresAt: now + SHARE_TTL_MS });
  promise.catch(() => {
    if (shared.get(k)?.promise === promise) shared.delete(k);
  });
  return promise;
}

/** 試験用 */
export function __resetSalesSummaryLoadShareForTest() {
  shared.clear();
}

/**
 * 読み込み（loadId）が違っても、いま数えている途中の同じ計算には相乗りする。
 * 開き直しで並んだ期間の読み込みが、同じ「店×日」を重ねて数えないため（Ciara 2026-11-24）。
 * 終わったら（成功・失敗とも）すぐ外すので、終わった計算の結果を使い回すことはない。
 * key には shopId を必ず含めること。
 */
const inFlight = new Map<string, Promise<unknown>>();

export function shareInFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = inFlight.get(key);
  if (hit) return hit as Promise<T>;
  const promise = fn();
  inFlight.set(key, promise);
  const clear = () => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

/** 同じ読み込みの中での共有と、読み込みをまたいだ「数えている途中」への相乗りの両方 */
export function shareSalesSummaryCompute<T>(
  loadId: string | null | undefined,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  return shareWithinLoad(loadId, key, () => shareInFlight(key, fn));
}

/** 試験用 */
export function __resetSalesSummaryInFlightForTest() {
  inFlight.clear();
}

/** いま数えている途中なら、その Promise（無ければ null） */
export function getInFlight<T>(key: string): Promise<T> | null {
  return (inFlight.get(key) as Promise<T> | undefined) ?? null;
}
