import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { AppNavBar } from "../components/AppNavBar";
import { isInhouseMode } from "../utils/planFeatures.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {
    shop: new URL(request.url).searchParams.get("shop") ?? "",
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    memberCardEnabled: isInhouseMode(),
  };
};

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

/**
 * レイアウトは POS Stock / location-stock-indicator と同一構成にする。
 * - AppProvider のみ（PolarisAppProvider は各ページ内でラップ）
 * - s-app-nav は AppProvider の直下
 * - 上部メニュー（AppNavBar）は s-app-nav の直下
 * - meta[shopify-api-key] は使わない（他アプリ同様。AppProvider が data-api-key で script に渡す）
 */
export default function AppLayout() {
  const { apiKey, memberCardEnabled } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  return (
    <AppProvider embedded apiKey={apiKey}>
      {isLoading && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            padding: "12px 16px",
            background: "#2563eb",
            color: "#fff",
            fontSize: "14px",
            fontWeight: 500,
            textAlign: "center",
            zIndex: 9999,
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}
        >
          読み込み中…
        </div>
      )}
      {/* 左サイドバー用（管理画面でアプリ選択時に下部などに出すメニュー）※他アプリ同様 href はパスのみ */}
      {/* @ts-expect-error s-app-nav / s-link は polaris.js の Web コンポーネント */}
      <s-app-nav>
        <s-link href="/app" rel="home">ホーム</s-link>
        <s-link href="/app/receipt-template">領収書テンプレート</s-link>
        <s-link href="/app/payment-methods">支払方法マスタ</s-link>
        <s-link href="/app/budget-management">予算管理</s-link>
        <s-link href="/app/general-settings">一般設定</s-link>
        <s-link href="/app/settlement-settings">精算設定</s-link>
        <s-link href="/app/print-settings">印字設定</s-link>
        <s-link href="/app/budget-settings">予算設定</s-link>
        <s-link href="/app/sales-summary-settings">売上サマリー設定</s-link>
        <s-link href="/app/loyalty-settings">ポイント/会員施策設定</s-link>
        <s-link href="/app/voucher-settings">商品券設定</s-link>
        <s-link href="/app/special-refund-settings">特殊返金設定</s-link>
        <s-link href="/app/settlement-history">精算履歴</s-link>
        <s-link href="/app/special-refund-history">特殊返金履歴</s-link>
        <s-link href="/app/receipt-history">領収書履歴</s-link>
        <s-link href="/app/settings">設定</s-link>
        <s-link href="/app/plan">料金プラン</s-link>
        <s-link href="/app/diagnostics">システム診断</s-link>
        {memberCardEnabled && (
          <s-link href="/app/member-card-admin">会員証（LIFF）</s-link>
        )}
      </s-app-nav>
      {/* 上部メニュー（s-app-nav が表示されない環境用・常に表示） */}
      <AppNavBar />
      <Outlet />
    </AppProvider>
  );
}
