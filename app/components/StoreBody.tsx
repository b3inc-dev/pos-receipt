/**
 * 店舗の画面（一覧・全店の決まり・まとめて変更・店ごとの編集）の本文の囲み。
 * Polaris の Page はスマホ幅で左右の余白が無いので、16px の余白を付ける（UI ルール 2章）。
 * CSS は adminCss と同じく、引用符と「>」を書かない（サーバーで描くと &quot; &gt; になる。13章）。
 */
import type { ReactNode } from "react";

const storeCss = `
  .Store-body .Store-bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 8px 0 12px; border-bottom: 1px solid #ebebeb; margin-bottom: 12px; }
  .Store-body .Store-check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }
  .Store-body .Store-bulk .Admin-secondary { margin-left: auto; }
  .Store-body .Store-bulk .Admin-secondary:disabled { opacity: .5; cursor: not-allowed; }
  .Store-body .Store-row-check { width: 16px; height: 16px; flex: 0 0 16px; margin: 0; }
  .Store-body .Store-row-order { display:flex;gap:4px;align-items:center;flex-wrap:wrap; }
  @media (max-width: 640px) {
    .Store-body .Store-order-row { flex-wrap:wrap; }
    .Store-body .Store-row-order { margin-left:24px;flex-basis:calc(100% - 24px); }
    .Store-body { padding: 0 16px 16px; }
    .Store-body .Store-bulk .Admin-secondary { margin-left: 0; width: 100%; justify-content: center; }
  }
`;

export function StoreBody({ children }: { children: ReactNode }) {
  return (
    <div className="Store-body">
      <style>{storeCss}</style>
      {children}
    </div>
  );
}
