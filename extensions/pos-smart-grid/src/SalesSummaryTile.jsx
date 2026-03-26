/**
 * 売上サマリータイル
 * 要件書 §7, §19.2
 * サブ見出しに当日の全店合計（実績・設定に応じて予算）を表示
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getDailySummary } from "../../common/salesSummaryApi.js";

export default async () => {
  render(<SalesSummaryTile />, document.body);
};

function fmtYen(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `¥${Math.round(Number(n)).toLocaleString("ja-JP")}`;
}

function SalesSummaryTile() {
  const [subheading, setSubheading] = useState("予算・実績確認");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getDailySummary({});
        if (cancelled || !data) return;
        const rows = data.rows ?? [];
        const channelRows = data.channelRows ?? [];
        if (rows.length === 0 && channelRows.length === 0) return;

        const o = data.displayOptions ?? {};
        const t = data.totals ?? {};
        const parts = [];
        if (o.showActual !== false) parts.push(`実績 ${fmtYen(t.actual)}`);
        if (o.showBudget && t.budget != null) parts.push(`予算 ${fmtYen(t.budget)}`);
        if (parts.length > 0) setSubheading(parts.join(" · "));
      } catch {
        /* 取得失敗時は初期文言のまま */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <s-tile
      heading="売上サマリー"
      subheading={subheading}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
