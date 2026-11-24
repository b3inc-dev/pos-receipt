import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import "@shopify/polaris/build/esm/styles.css";
import "../styles/admin-chrome.css";
import { authenticate } from "../shopify.server";
import { LoadingIndicator } from "../components/admin-ui";
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
      <LoadingIndicator loading={isLoading} />
      {/* 左サイドバー用（管理画面でアプリ選択時に下部などに出すメニュー）※他アプリ同様 href はパスのみ */}
      {/* @ts-expect-error s-app-nav / s-link は polaris.js の Web コンポーネント */}
      <s-app-nav>
        <s-link href="/app" rel="home">ホーム</s-link>
        <s-link href="/app/receipt-layouts">レシート</s-link>
        <s-link href="/app/settlement-settings">精算</s-link>
        <s-link href="/app/settings">店舗</s-link>
        <s-link href="/app/sales-summary">レポート</s-link>
        <s-link href="/app/budget-management">予算</s-link>
        <s-link href="/app/general-settings">システム</s-link>
      </s-app-nav>
      {/* 上部メニュー（s-app-nav が表示されない環境用・常に表示） */}
      <AppNavBar />
      <Outlet />
    </AppProvider>
  );
}
