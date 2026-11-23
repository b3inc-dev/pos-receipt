/**
 * POS の読み込み中の表示を全画面で揃えるための決まり（T 2026-11-24 決定カード「青い帯ひとつに揃える」）。
 *
 * - 読み込み中は、青い帯「読み込み中です。少しお待ちください。」だけを、見出しのすぐ下（固定の帯の直下）に出す。
 *   読み込みの段階がいくつあっても、見た目は 1 つ（途中で別の表示に切り替えない）。
 * - 「再読み込み」は読み込み中には出さない。失敗したとき、または 10 秒ほど待たされたときだけ帯の下に出す。
 * - 見出し・日付・下のボタンなどの枠は先に出し、押せないボタンは薄くする（各画面の disabled）。
 *
 * 画面の部品は extensions/pos-smart-grid/src/LoadingNotice.jsx。ここは見た目を決める純粋な関数だけ（テスト用）。
 */

export const LOADING_MESSAGE = "読み込み中です。少しお待ちください。";

/** この時間より長く読み込み中なら「再読み込み」を出す（ミリ秒） */
export const SLOW_LOADING_MS = 10_000;

export const RETRY_LABEL = "再読み込み";

/**
 * @param {{ loading?: boolean, error?: string | null, slow?: boolean, canRetry?: boolean, busyLabel?: string }} p
 * @returns {{ tone: "info" | "critical" | null, heading: string, showRetry: boolean }}
 */
export function loadingNoticeView({ loading, error, slow, canRetry, busyLabel } = {}) {
  if (loading) {
    return {
      tone: "info",
      heading: busyLabel || LOADING_MESSAGE,
      showRetry: Boolean(slow && canRetry),
    };
  }
  const msg = typeof error === "string" ? error.trim() : "";
  if (msg) {
    return { tone: "critical", heading: msg, showRetry: Boolean(canRetry) };
  }
  return { tone: null, heading: "", showRetry: false };
}

/**
 * 画面全体ではなく一部（欄・ボタンの中など）を読み込んでいるときの文字。
 * 「精算の数を」「月一覧を」などの前置きは付けず、どこでもこれだけにする（T 2026-11-24）。
 */
export const INLINE_LOADING_TEXT = "読み込み中…";
