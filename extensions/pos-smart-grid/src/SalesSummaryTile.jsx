/**
 * 売上サマリータイル
 * 要件書 §7, §19.2
 * サブ見出し: POS で店舗が取れているときはその店の実績・予算のみ。
 * 店舗未確定時は全店合計＋設定 ON ならチャネル抜粋。
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getDailySummary } from "../../common/salesSummaryApi.js";
import { useSessionLocation } from "../../common/sessionLocation.js";

export default async () => {
  render(<SalesSummaryTile />, document.body);
};

function fmtYen(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `¥${Math.round(Number(n)).toLocaleString("ja-JP")}`;
}

function SalesSummaryTile() {
  const [subheading, setSubheading] = useState("予算・実績確認");
  const { locationGid, isReady } = useSessionLocation();

  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    (async () => {
      try {
        // POS で店舗が決まっているときはその店だけ取得し、タイルに EC チャネル抜粋を付けない
        const singleLocationTile = Boolean(locationGid);
        const data = await getDailySummary(
          singleLocationTile ? { locationIds: [locationGid] } : {},
        );
        if (cancelled || !data) return;
        const rows = data.rows ?? [];
        const channelRows = data.channelRows ?? [];
        if (singleLocationTile) {
          if (rows.length === 0) return;
        } else if (rows.length === 0 && channelRows.length === 0) {
          return;
        }

        const o = data.displayOptions ?? {};
        const parts = [];

        if (singleLocationTile) {
          const locActual = rows.reduce((s, r) => s + (Number(r.actual) || 0), 0);
          const budgets = rows.map((r) => r.budget);
          const locBudget =
            budgets.length > 0 && budgets.every((b) => b != null)
              ? budgets.reduce((s, b) => s + Number(b), 0)
              : null;
          if (o.showActual !== false) parts.push(`実績 ${fmtYen(locActual)}`);
          if (o.showBudget && locBudget != null) parts.push(`予算 ${fmtYen(locBudget)}`);
        } else {
          const t = data.totals ?? {};
          if (o.showActual !== false) parts.push(`実績 ${fmtYen(t.actual)}`);
          if (o.showBudget && t.budget != null) parts.push(`予算 ${fmtYen(t.budget)}`);

          if (o.showChannelOnTile !== false && channelRows.length > 0) {
            const maxCh = 4;
            const slice = channelRows.slice(0, maxCh);
            const chParts = slice.map((r) => {
              const label = String(r.channelName ?? "").trim().slice(0, 8) || "CH";
              return `${label} ${fmtYen(r.actual)}`;
            });
            const more =
              channelRows.length > maxCh ? ` · +${channelRows.length - maxCh}` : "";
            parts.push(`${chParts.join(" · ")}${more}`);
          }
        }

        if (parts.length > 0) setSubheading(parts.join(" · "));
      } catch {
        /* 取得失敗時は初期文言のまま */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isReady, locationGid]);

  return (
    <s-tile
      heading="売上サマリー"
      subheading={subheading}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
