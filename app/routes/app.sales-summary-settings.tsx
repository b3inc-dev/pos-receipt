/**
 * /app/sales-summary-settings — 売上サマリー設定（要約の一覧）
 *
 * 区分ごとに今の設定を 1 行で見せ、「編集」で区分だけの画面（/app/sales-summary-settings/:section）を開く。
 * Shop Point の設定と同じ「要約の行＋編集」（T 11/23・11/24 全画面点検）。読む側（POS・公開ページ）は変えない。
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate } from "react-router";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { loadSalesSummarySettingsPage } from "../utils/salesSummarySettings.server";
import { SECTION_ORDER, SECTION_TITLES, sectionSummary, type SalesSummarySectionKey } from "../utils/salesSummarySettingsSections";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, REPORTS_TABS } from "../components/TabGroupBar";
import { AdminBlock, AdminIntro, StateBadge, SummaryRows } from "../components/admin-ui";
import { StoreBody } from "../components/StoreBody";
import { withSearch } from "../utils/withSearch";

const ICONS: Record<SalesSummarySectionKey, string> = {
  basic: "settings",
  display: "store",
  numbers: "chart-vertical",
  footfall: "person",
  link: "link",
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const { settings, locations, link } = await loadSalesSummarySettingsPage(admin, session.shop);
  return {
    enabled: settings.salesSummaryEnabled,
    rows: SECTION_ORDER.map((key) => ({ key, text: sectionSummary(key, settings, locations, link) })),
  };
}

export default function SalesSummarySettingsPage() {
  const { enabled, rows } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const q = useLocation().search || "";
  return (
    <PolarisPageWrapper>
      <Page title="売上サマリー設定" backAction={{ content: "ホーム", onAction: () => navigate(withSearch("/app", q)) }}>
        <TabGroupBar tabs={REPORTS_TABS} />
        <StoreBody>
          <AdminIntro>
            <p>POS の売上サマリーに出すものを決めます。変えたい行の「編集」を押してください。</p>
          </AdminIntro>
          <AdminBlock title="設定" description={enabled ? "外した項目は、POS の売上サマリーに出ません。" : "今は売上サマリーを使っていません。「使い方」で使うようにできます。"}>
            <SummaryRows
              rows={rows.map((row) => ({
                key: row.key,
                icon: ICONS[row.key],
                title: (
                  <>
                    {SECTION_TITLES[row.key]}
                    {row.key === "basic" && !enabled ? <StateBadge label="使っていません" tone="warning" /> : null}
                  </>
                ),
                text: row.text,
                to: withSearch(`/app/sales-summary-settings/${row.key}`, q),
              }))}
            />
          </AdminBlock>
        </StoreBody>
      </Page>
    </PolarisPageWrapper>
  );
}
