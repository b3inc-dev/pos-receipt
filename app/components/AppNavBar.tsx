/**
 * 管理画面用の常時表示ナビゲーション。
 * React Router の Link で遷移するため、Embedded App でも確実にページが切り替わる。
 * （左サイドバー s-app-nav が表示されない環境でもメニューを提供する）
 */
import { Link, useLocation } from "react-router";

const NAV_ITEMS = [
  { path: "/app", label: "ホーム" },
  { path: "/app/receipt-template", label: "領収書テンプレート" },
  { path: "/app/budget-management", label: "予算管理" },
  { path: "/app/settlement-history", label: "精算履歴" },
  { path: "/app/special-refund-history", label: "特殊返金履歴" },
  { path: "/app/receipt-history", label: "領収書履歴" },
  { path: "/app/settings", label: "設定" },
  { path: "/app/plan", label: "プラン・課金" },
  { path: "/app/diagnostics", label: "システム診断" },
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
        const isActive = location.pathname === path;
        return (
          <Link
            key={path}
            to={to}
            style={{
              color: isActive ? "#005bd3" : "#202223",
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
