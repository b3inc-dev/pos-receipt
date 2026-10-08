/**
 * グループ内タブナビゲーション。
 * ロードマップ: レシート / 精算 / 店舗 / レポート / システム（高度はラベルで区別）
 * 設定項目は削らず再配置のみ。
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

/** 1. レシート */
export const RECEIPT_TABS: TabItem[] = [
  { path: "/app/sales-receipt-layout", label: "販売レイアウト" },
  { path: "/app/sales-receipt-settings", label: "販売レシート設定" },
  { path: "/app/receipt-template", label: "領収書テンプレート" },
  { path: "/app/receipt-history", label: "領収書履歴" },
  { path: "/app/print-settings", label: "印字設定" },
];

/** 2. 精算 */
export const SETTLEMENT_TABS: TabItem[] = [
  { path: "/app/settlement-settings", label: "精算設定" },
  { path: "/app/settlement-history", label: "精算履歴" },
  { path: "/app/special-refund-settings", label: "特殊返金設定" },
  { path: "/app/special-refund-history", label: "特殊返金履歴" },
  { path: "/app/voucher-settings", label: "商品券設定" },
];

/** 3. 店舗 */
export const STORE_TABS: TabItem[] = [
  { path: "/app/settings", label: "ロケーション" },
  { path: "/app/location-profiles", label: "設定軸・一括反映" },
  { path: "/app/payment-methods", label: "支払方法マスタ" },
];

/** 4. レポート */
export const REPORTS_TABS: TabItem[] = [
  { path: "/app/sales-summary", label: "売上サマリー" },
  { path: "/app/sales-summary-settings", label: "サマリー設定" },
  { path: "/app/sales-channels", label: "チャネル管理" },
  { path: "/app/budget-management", label: "予算管理" },
  { path: "/app/budget-settings", label: "予算設定" },
  { path: "/app/channel-budget-management", label: "チャネル予算" },
];

/** 5. システム（diagnostics / backfill は高度） */
export function buildSystemTabs(memberCardEnabled: boolean): TabItem[] {
  const tabs: TabItem[] = [
    { path: "/app/plan", label: "料金プラン" },
    { path: "/app/general-settings", label: "一般設定" },
    { path: "/app/loyalty-settings", label: "ポイント/会員施策" },
    { path: "/app/diagnostics", label: "（高度）システム診断" },
    { path: "/app/backfill", label: "（高度）過去データ取込" },
  ];
  if (memberCardEnabled) {
    tabs.push({ path: "/app/member-card-admin", label: "会員証（LIFF）" });
  }
  return tabs;
}

/** @deprecated 旧「設定」タブ — 移行用。新規は RECEIPT/SETTLEMENT/STORE を使う */
export const SETTINGS_TABS: TabItem[] = [
  ...STORE_TABS,
  ...SETTLEMENT_TABS.filter((t) => t.path.includes("settings")),
  ...RECEIPT_TABS.filter((t) => t.path === "/app/print-settings"),
  ...REPORTS_TABS.filter((t) => t.path.includes("settings") || t.path === "/app/sales-channels"),
  { path: "/app/loyalty-settings", label: "ポイント/会員施策" },
  { path: "/app/general-settings", label: "一般設定" },
];

/** @deprecated 旧マスタ — RECEIPT + STORE へ分割 */
export const MASTER_TABS: TabItem[] = [
  { path: "/app/receipt-template", label: "領収書テンプレート" },
  { path: "/app/payment-methods", label: "支払方法マスタ" },
];
