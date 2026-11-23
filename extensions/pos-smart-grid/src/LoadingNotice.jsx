import { useEffect, useState } from "preact/hooks";
import {
  loadingNoticeView,
  RETRY_LABEL,
  SLOW_LOADING_MS,
} from "../../common/loadingNotice.js";

/**
 * 読み込み中・読み込み失敗の案内（全タイル・全画面で同じもの。T 2026-11-24）。
 *
 * 置き場所は「見出しのすぐ下」＝上の固定の帯の直下（スクロールする中身のいちばん上）。
 * loading には、その画面で待っている読み込みを全部まとめた真偽値を渡す
 * （店の確認 → 一覧 → 中身 のように段階があっても、帯は 1 つのまま出し続ける）。
 *
 * - 読み込み中: 青い帯「読み込み中です。少しお待ちください。」。10 秒を過ぎたら下に「再読み込み」
 * - 失敗: 赤い帯（文は error）と「再読み込み」
 * - どちらでもない: 何も出さない
 *
 * s-banner の文は heading に入れる（端末によって本文が畳まれることがあるため）。
 */
export function LoadingNotice({
  loading = false,
  error = "",
  onRetry,
  retryLabel = RETRY_LABEL,
  busyLabel,
  slowAfterMs = SLOW_LOADING_MS,
}) {
  const [slow, setSlow] = useState(false);
  // 「再読み込み」を押したら待ち時間を数え直す（読み込み中のまま押されても、ボタンをいったん消す）
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    setSlow(false);
    if (!loading || !onRetry) return undefined;
    const t = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(t);
  }, [loading, retryCount, slowAfterMs, Boolean(onRetry)]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = loadingNoticeView({
    loading,
    error,
    slow,
    canRetry: typeof onRetry === "function",
    busyLabel,
  });
  if (!view.tone) return null;

  return (
    <s-stack gap="small">
      <s-banner tone={view.tone} heading={view.heading} />
      {view.showRetry ? (
        <s-button
          variant="secondary"
          onClick={() => {
            setRetryCount((n) => n + 1);
            onRetry();
          }}
        >
          {retryLabel}
        </s-button>
      ) : null}
    </s-stack>
  );
}

/**
 * 中身を出す前に読み込むだけの画面（取引詳細から開いたときに注文を読むあいだ など）。
 * 見出しは先に出し、その下に同じ青い帯ひとつ。
 */
export function LoadingPage({ heading, onRetry }) {
  return (
    <s-page heading={heading}>
      <s-box padding="base">
        <LoadingNotice loading onRetry={onRetry} />
      </s-box>
    </s-page>
  );
}
