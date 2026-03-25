/**
 * グループ内タブナビゲーションコンポーネント。
 * 複数ページをタブとして束ね、現在のパスに応じてアクティブタブを強調表示する。
 */
import { Tabs } from "@shopify/polaris";
import { useNavigate, useLocation } from "react-router";
import { useMemo } from "react";

export interface TabItem {
  path: string;
  label: string;
}

interface TabGroupBarProps {
  tabs: TabItem[];
}

export function TabGroupBar({ tabs }: TabGroupBarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const search = location.search || "";

  const selected = useMemo(() => {
    const idx = tabs.findIndex((t) => t.path === location.pathname);
    return idx >= 0 ? idx : 0;
  }, [tabs, location.pathname]);

  return (
    <Tabs
      tabs={tabs.map((t, i) => ({ id: `tab-${i}`, content: t.label }))}
      selected={selected}
      onSelect={(index) => navigate(tabs[index].path + search)}
    />
  );
}

// ── タブ定義 ──────────────────────────────────────────────────

export const SETTINGS_TABS: TabItem[] = [
  { path: "/app/settings", label: "ロケーション" },
  { path: "/app/general-settings", label: "一般設定" },
  { path: "/app/print-settings", label: "印字設定" },
  { path: "/app/settlement-settings", label: "精算設定" },
  { path: "/app/sales-summary-settings", label: "売上サマリー" },
  { path: "/app/sales-channels", label: "チャネル管理" },
  { path: "/app/loyalty-settings", label: "ポイント/会員施策" },
  { path: "/app/voucher-settings", label: "商品券設定" },
  { path: "/app/special-refund-settings", label: "特殊返金設定" },
  { path: "/app/budget-settings", label: "予算設定" },
];

export const MASTER_TABS: TabItem[] = [
  { path: "/app/receipt-template", label: "領収書テンプレート" },
  { path: "/app/payment-methods", label: "支払方法マスタ" },
];

export const REPORTS_TABS: TabItem[] = [
  { path: "/app/settlement-history", label: "精算履歴" },
  { path: "/app/special-refund-history", label: "特殊返金履歴" },
  { path: "/app/receipt-history", label: "領収書履歴" },
  { path: "/app/budget-management", label: "予算管理" },
];

export function buildSystemTabs(memberCardEnabled: boolean): TabItem[] {
  const tabs: TabItem[] = [
    { path: "/app/plan", label: "料金プラン" },
    { path: "/app/diagnostics", label: "システム診断" },
    { path: "/app/backfill", label: "過去データ取込" },
  ];
  if (memberCardEnabled) {
    tabs.push({ path: "/app/member-card-admin", label: "会員証（LIFF）" });
  }
  return tabs;
}
