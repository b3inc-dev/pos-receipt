/**
 * /app/sales-summary-settings — 売上サマリー設定
 * 要件 §10: 表示内容・KPI表示制御・入店数報告のON/OFF
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit, useLocation, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Checkbox,
  Button,
  BlockStack,
  Banner,
  Box,
  InlineStack,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  getAppSetting,
  setAppSetting,
  SALES_SUMMARY_SETTINGS_KEY,
  DEFAULT_SALES_SUMMARY_SETTINGS,
  type SalesSummarySettings,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const LOCATIONS_QUERY = `#graphql
  query Locations {
    locations(first: 50, includeLegacy: false) {
      edges { node { id name isActive } }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const locRes = await admin.graphql(LOCATIONS_QUERY);
  const locJson = (await locRes.json()) as {
    data?: { locations?: { edges?: { node: { id: string; name: string; isActive: boolean } }[] } };
  };
  const locations = (locJson.data?.locations?.edges ?? [])
    .map((e) => e.node)
    .filter((l) => l.isActive);

  const saved = await getAppSetting<Partial<SalesSummarySettings>>(shop.id, SALES_SUMMARY_SETTINGS_KEY);
  const settings: SalesSummarySettings = {
    ...DEFAULT_SALES_SUMMARY_SETTINGS,
    ...saved,
    visibleLocationIds: Array.isArray(saved?.visibleLocationIds) ? saved.visibleLocationIds : DEFAULT_SALES_SUMMARY_SETTINGS.visibleLocationIds,
    footfallTargetLocationIds: Array.isArray(saved?.footfallTargetLocationIds) ? saved.footfallTargetLocationIds : DEFAULT_SALES_SUMMARY_SETTINGS.footfallTargetLocationIds,
  };

  return { settings, locations };
}

function formDataToSettings(formData: FormData, locations: { id: string }[]): SalesSummarySettings {
  const get = (k: string) => formData.get(k);
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const visibleIds = formData.get("visibleLocationIds");
  const footfallIds = formData.get("footfallTargetLocationIds");
  return {
    ...DEFAULT_SALES_SUMMARY_SETTINGS,
    salesSummaryEnabled: bool("salesSummaryEnabled", true),
    allowSingleDateSummary: bool("allowSingleDateSummary", true),
    allowDateRangeSummary: bool("allowDateRangeSummary", true),
    showLocationRows: bool("showLocationRows", true),
    showStoreTotals: bool("showStoreTotals", true),
    showOverallTotals: bool("showOverallTotals", true),
    visibleLocationIds: visibleIds ? (JSON.parse(visibleIds as string) as string[]) : [],
    showBudget: bool("showBudget", true),
    showActual: bool("showActual", true),
    showBudgetRatio: bool("showBudgetRatio", true),
    showOrders: bool("showOrders", true),
    showVisitors: bool("showVisitors", true),
    showConv: bool("showConv", true),
    showAtv: bool("showAtv", true),
    showSetRate: bool("showSetRate", true),
    showItems: bool("showItems", true),
    showUnitPrice: bool("showUnitPrice", true),
    showMonthBudget: bool("showMonthBudget", true),
    showMonthActual: bool("showMonthActual", true),
    showMonthAchvRatio: bool("showMonthAchvRatio", true),
    showProgressToday: bool("showProgressToday", true),
    showProgressPrev: bool("showProgressPrev", true),
    showLoyaltyUsage: bool("showLoyaltyUsage", true),
    loyaltyUsageSummaryLabel: String(get("loyaltyUsageSummaryLabel") ?? "ポイント利用額").trim(),
    footfallReportingEnabled: bool("footfallReportingEnabled", true),
    footfallTargetLocationIds: footfallIds ? (JSON.parse(footfallIds as string) as string[]) : [],
    footfallReportEditableAfterSubmit: bool("footfallReportEditableAfterSubmit", false),
    footfallReportRequiresConfirmation: bool("footfallReportRequiresConfirmation", true),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const locRes = await admin.graphql(LOCATIONS_QUERY);
  const locJson = (await locRes.json()) as {
    data?: { locations?: { edges?: { node: { id: string } }[] } };
  };
  const locations = (locJson.data?.locations?.edges ?? []).map((e) => e.node);

  const formData = await request.formData();
  const settings = formDataToSettings(formData, locations);
  await setAppSetting(shop.id, SALES_SUMMARY_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function SalesSummarySettingsPage() {
  const { settings: initial, locations } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<SalesSummarySettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      if (typeof v === "boolean") fd.set(k, v ? "true" : "false");
      else if (typeof v === "string") fd.set(k, v);
      else if (Array.isArray(v)) fd.set(k, JSON.stringify(v));
    });
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = <K extends keyof SalesSummarySettings>(key: K, value: SalesSummarySettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const isVisible = (locationId: string) =>
    form.visibleLocationIds.length === 0 || form.visibleLocationIds.includes(locationId);
  const isFootfallTarget = (locationId: string) =>
    form.footfallTargetLocationIds.length === 0 || form.footfallTargetLocationIds.includes(locationId);

  const toggleVisibleLocation = (locationId: string) => {
    setForm((prev) => {
      const showAll = prev.visibleLocationIds.length === 0;
      const currentlyChecked = showAll || prev.visibleLocationIds.includes(locationId);
      if (currentlyChecked) {
        if (showAll)
          return { ...prev, visibleLocationIds: locations.map((l) => l.id).filter((id) => id !== locationId) };
        return { ...prev, visibleLocationIds: prev.visibleLocationIds.filter((id) => id !== locationId) };
      }
      const next = [...prev.visibleLocationIds, locationId];
      return { ...prev, visibleLocationIds: next.length === locations.length ? [] : next };
    });
  };

  const toggleFootfallLocation = (locationId: string) => {
    setForm((prev) => {
      const showAll = prev.footfallTargetLocationIds.length === 0;
      const currentlyChecked = showAll || prev.footfallTargetLocationIds.includes(locationId);
      if (currentlyChecked) {
        if (showAll)
          return { ...prev, footfallTargetLocationIds: locations.map((l) => l.id).filter((id) => id !== locationId) };
        return { ...prev, footfallTargetLocationIds: prev.footfallTargetLocationIds.filter((id) => id !== locationId) };
      }
      const next = [...prev.footfallTargetLocationIds, locationId];
      return { ...prev, footfallTargetLocationIds: next.length === locations.length ? [] : next };
    });
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="売上サマリー設定"
        backAction={{ content: "戻る", onAction: () => navigate("/app/settings" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Layout>
          {saved && (
            <Layout.Section>
              <Banner tone="success">保存しました。</Banner>
            </Layout.Section>
          )}

          <Layout.Section>
            <Banner tone="info">
              POS の売上サマリー画面で表示する項目や入店数報告の有無を設定します。ここで OFF にした項目はサマリーに表示されません。
            </Banner>
          </Layout.Section>

          {/* §10.2.1 売上サマリー全体 */}
          <Layout.AnnotatedSection
            title="売上サマリー全体"
            description="サマリー機能の有効化と日次/期間の許可"
          >
            <Card>
              <BlockStack gap="300">
                <Checkbox
                  label="売上サマリーを有効にする"
                  checked={form.salesSummaryEnabled}
                  onChange={(v) => set("salesSummaryEnabled", v)}
                />
                <Checkbox
                  label="単日サマリーを許可"
                  checked={form.allowSingleDateSummary}
                  onChange={(v) => set("allowSingleDateSummary", v)}
                />
                <Checkbox
                  label="期間サマリーを許可"
                  checked={form.allowDateRangeSummary}
                  onChange={(v) => set("allowDateRangeSummary", v)}
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {/* §10.2.2 表示対象 */}
          <Layout.AnnotatedSection
            title="表示対象"
            description="ロケーション行と合計の表示、表示するロケーション"
          >
            <Card>
              <BlockStack gap="400">
                <Checkbox
                  label="ロケーション行を表示"
                  checked={form.showLocationRows}
                  onChange={(v) => set("showLocationRows", v)}
                />
                <Checkbox
                  label="店舗合計を表示"
                  checked={form.showStoreTotals}
                  onChange={(v) => set("showStoreTotals", v)}
                />
                <Checkbox
                  label="全体合計を表示"
                  checked={form.showOverallTotals}
                  onChange={(v) => set("showOverallTotals", v)}
                />
                <Text as="p" variant="bodySm" fontWeight="semibold">サマリーに表示するロケーション（空で全件）</Text>
                <Box paddingBlockStart="200">
                  <BlockStack gap="200">
                    {locations.map((loc) => (
                      <Checkbox
                        key={loc.id}
                        label={loc.name}
                        checked={isVisible(loc.id)}
                        onChange={() => toggleVisibleLocation(loc.id)}
                        helpText={form.visibleLocationIds.length === 0 ? "全ロケーション表示" : undefined}
                      />
                    ))}
                  </BlockStack>
                </Box>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {/* §10.2.3 KPI 表示制御 */}
          <Layout.AnnotatedSection
            title="KPI 表示制御"
            description="サマリー画面で表示する KPI の ON/OFF"
          >
            <Card>
              <BlockStack gap="200">
                <InlineStack gap="400" wrap>
                  <Checkbox label="予算" checked={form.showBudget} onChange={(v) => set("showBudget", v)} />
                  <Checkbox label="実績" checked={form.showActual} onChange={(v) => set("showActual", v)} />
                  <Checkbox label="予算比" checked={form.showBudgetRatio} onChange={(v) => set("showBudgetRatio", v)} />
                  <Checkbox label="注文数" checked={form.showOrders} onChange={(v) => set("showOrders", v)} />
                  <Checkbox label="入店数" checked={form.showVisitors} onChange={(v) => set("showVisitors", v)} />
                  <Checkbox label="購買率" checked={form.showConv} onChange={(v) => set("showConv", v)} />
                  <Checkbox label="客単価" checked={form.showAtv} onChange={(v) => set("showAtv", v)} />
                  <Checkbox label="セット率" checked={form.showSetRate} onChange={(v) => set("showSetRate", v)} />
                  <Checkbox label="商品数" checked={form.showItems} onChange={(v) => set("showItems", v)} />
                  <Checkbox label="一品単価" checked={form.showUnitPrice} onChange={(v) => set("showUnitPrice", v)} />
                  <Checkbox label="月予算" checked={form.showMonthBudget} onChange={(v) => set("showMonthBudget", v)} />
                  <Checkbox label="月実績" checked={form.showMonthActual} onChange={(v) => set("showMonthActual", v)} />
                  <Checkbox label="月達成率" checked={form.showMonthAchvRatio} onChange={(v) => set("showMonthAchvRatio", v)} />
                  <Checkbox label="本日の進捗" checked={form.showProgressToday} onChange={(v) => set("showProgressToday", v)} />
                  <Checkbox label="前日比" checked={form.showProgressPrev} onChange={(v) => set("showProgressPrev", v)} />
                  <Checkbox label="ポイント利用額" checked={form.showLoyaltyUsage} onChange={(v) => set("showLoyaltyUsage", v)} />
                </InlineStack>
                <TextField
                  label="ポイント利用額のラベル"
                  value={form.loyaltyUsageSummaryLabel}
                  onChange={(v) => set("loyaltyUsageSummaryLabel", v)}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {/* §10.2.4 入店数報告 */}
          <Layout.AnnotatedSection
            title="入店数報告"
            description="売上サマリー画面内の入店数入力の有無と対象ロケーション"
          >
            <Card>
              <BlockStack gap="400">
                <Checkbox
                  label="入店数報告を有効にする"
                  checked={form.footfallReportingEnabled}
                  onChange={(v) => set("footfallReportingEnabled", v)}
                />
                <Text as="p" variant="bodySm" fontWeight="semibold">入店数入力対象ロケーション（空で全件）</Text>
                <BlockStack gap="200">
                  {locations.map((loc) => (
                    <Checkbox
                      key={loc.id}
                      label={loc.name}
                      checked={isFootfallTarget(loc.id)}
                      onChange={() => toggleFootfallLocation(loc.id)}
                    />
                  ))}
                </BlockStack>
                <Checkbox
                  label="送信後の編集を許可"
                  checked={form.footfallReportEditableAfterSubmit}
                  onChange={(v) => set("footfallReportEditableAfterSubmit", v)}
                />
                <Checkbox
                  label="送信前に確認を求める"
                  checked={form.footfallReportRequiresConfirmation}
                  onChange={(v) => set("footfallReportRequiresConfirmation", v)}
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.Section>
            <InlineStack align="end">
              <Button variant="primary" onClick={handleSave}>保存</Button>
            </InlineStack>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
