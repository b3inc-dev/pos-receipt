/**
 * 管理画面用の常時表示ナビゲーション（5グループ）。
 * レシート / 精算 / 店舗 / レポート / システム
 * 見た目は共通の部品（admin-ui.tsx の AppNavBarView）。選択中は灰色の角丸、スマホは1行の横スライド（UI ルール v1.1 3章）。
 * グループの中の画面でも親を選択中にする（match）。共通の CSS（AdminStyle）は、レイアウトで1回だけ描かれるこのメニューと一緒に描く（13章）。
 */
import { useLocation } from "react-router";
import { AdminStyle, AppNavBarView } from "./admin-ui";

/** グループに属するパス（アクティブ判定用） */
const GROUP_PATHS: Record<string, string[]> = {
  "/app/sales-receipt-layout": [
    "/app/sales-receipt-layout",
    "/app/sales-receipt-settings",
    "/app/receipt-template",
    "/app/receipt-print-layout",
    "/app/receipt-history",
    "/app/print-settings",
  ],
  "/app/settlement-settings": [
    "/app/settlement-settings",
    "/app/settlement-calc-settings",
    "/app/settlement-print-layout",
    "/app/settlement-history",
    "/app/special-refund-settings",
    "/app/special-refund-history",
    "/app/voucher-settings",
  ],
  "/app/settings": [
    "/app/settings",
    "/app/location-profiles",
    "/app/payment-methods",
  ],
  "/app/sales-summary": [
    "/app/sales-summary",
    "/app/sales-summary-settings",
    "/app/sales-channels",
    "/app/budget-management",
    "/app/budget-settings",
    "/app/channel-budget-management",
  ],
  "/app/plan": [
    "/app/plan",
    "/app/general-settings",
    "/app/loyalty-settings",
    "/app/diagnostics",
    "/app/backfill",
    "/app/member-card-admin",
  ],
};

const NAV_ITEMS = [
  { path: "/app", label: "ホーム" },
  { path: "/app/sales-receipt-layout", label: "レシート" },
  { path: "/app/settlement-settings", label: "精算" },
  { path: "/app/settings", label: "店舗" },
  { path: "/app/sales-summary", label: "レポート" },
  { path: "/app/plan", label: "システム" },
];

export function AppNavBar() {
  const location = useLocation();
  const search = location.search || "";

  const items = NAV_ITEMS.map((item) => ({ ...item, match: GROUP_PATHS[item.path] }));

  return (
    <>
      <AdminStyle />
      <AppNavBarView items={items} pathname={location.pathname} search={search} />
    </>
  );
}
