/**
 * 管理画面用の常時表示ナビゲーション。
 * React Router の Link で遷移するため、Embedded App でも確実にページが切り替わる。
 * （左サイドバー s-app-nav が表示されない環境でもメニューを提供する）
 */
import { Link, useLocation } from "react-router";

/** グループに属するパス（アクティブ判定用） */
const GROUP_PATHS: Record<string, string[]> = {
  "/app/settings": [
    "/app/settings",
    "/app/general-settings",
    "/app/print-settings",
    "/app/settlement-settings",
    "/app/sales-summary-settings",
    "/app/loyalty-settings",
    "/app/voucher-settings",
    "/app/special-refund-settings",
    "/app/budget-settings",
  ],
  "/app/receipt-template": ["/app/receipt-template", "/app/payment-methods"],
  "/app/settlement-history": [
    "/app/settlement-history",
    "/app/special-refund-history",
    "/app/receipt-history",
    "/app/budget-management",
  ],
  "/app/plan": ["/app/plan", "/app/diagnostics", "/app/backfill", "/app/member-card-admin"],
};

const NAV_ITEMS = [
  { path: "/app", label: "ホーム" },
  { path: "/app/settings", label: "設定" },
  { path: "/app/receipt-template", label: "マスタ管理" },
  { path: "/app/settlement-history", label: "レポート・履歴" },
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
        const isActive = location.pathname === path ||
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
