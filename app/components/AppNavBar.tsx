/**
 * 管理画面用の常時表示ナビゲーション（5グループ）。
 * レシート / 精算 / 店舗 / レポート / システム
 */
import { Link, useLocation } from "react-router";

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

  return (
    <nav
      data-app-nav="pos-receipt"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 16px",
        alignItems: "center",
        padding: "12px 20px",
        marginBottom: "16px",
        background: "#f6f6f7",
        borderBottom: "1px solid #e1e3e5",
        fontSize: "14px",
        position: "relative",
        zIndex: 100,
        minHeight: "44px",
        boxSizing: "border-box",
      }}
    >
      {NAV_ITEMS.map(({ path, label }) => {
        const to = path + search;
        const groupPaths = GROUP_PATHS[path];
        const isActive =
          location.pathname === path ||
          (groupPaths !== undefined && groupPaths.includes(location.pathname));
        return (
          <Link
            key={path}
            to={to}
            style={{
              color: isActive ? "#2c6ecb" : "#202223",
              fontWeight: isActive ? 600 : 400,
              textDecoration: "none",
            }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
