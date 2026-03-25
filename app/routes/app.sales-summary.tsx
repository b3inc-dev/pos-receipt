/**
 * /app/sales-summary — 管理画面用 売上サマリー（閲覧専用）
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Banner,
  BlockStack,
  InlineStack,
  Select,
  Box,
  DataTable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, checkPlanAccess } from "../utils/planFeatures.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import {
  getAppSetting,
  SALES_SUMMARY_SETTINGS_KEY,
  mergeAndNormalizeSalesSummarySettings,
  type SalesSummarySettings,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, REPORTS_TABS } from "../components/TabGroupBar";

function fmtYen(n: number | null) {
  if (n === null) return "-";
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}
function fmtPct(n: number | null) {
  if (n === null) return "-";
  return `${(n * 100).toFixed(1)}%`;
}
function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const dateFrom = `${month}-01`;
  const last = new Date(y, m, 0).getDate();
  const dateTo = `${month}-${String(last).padStart(2, "0")}`;
  return { dateFrom, dateTo };
}
function eachDay(dateFrom: string, dateTo: string) {
  const days: string[] = [];
  const start = new Date(`${dateFrom}T00:00:00Z`).getTime();
  const end = new Date(`${dateTo}T00:00:00Z`).getTime();
  for (let t = start; t <= end; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = await resolveShop(session.shop, admin);
    const fullAccess = await getFullAccess(admin, session);
    const access = checkPlanAccess(shop.planCode, "sales_summary", fullAccess);

    const url = new URL(request.url);
    const view = url.searchParams.get("view") === "period" ? "period" : "daily";
    const targetDate = url.searchParams.get("targetDate") ?? new Date().toISOString().slice(0, 10);
    const targetMonth = url.searchParams.get("targetMonth") ?? targetDate.slice(0, 7);
    const selectedLocationId = url.searchParams.get("locationId") ?? "";

    const allLocations = await prisma.location.findMany({
      where: { shopId: shop.id, salesSummaryEnabled: true },
      orderBy: { name: "asc" },
    });
    const settings = await getAppSetting<Partial<SalesSummarySettings>>(shop.id, SALES_SUMMARY_SETTINGS_KEY);
    const merged = mergeAndNormalizeSalesSummarySettings(settings ?? undefined);
    const visibleLocations =
      merged.visibleLocationIds.length > 0
        ? allLocations.filter((l) => merged.visibleLocationIds.includes(l.shopifyLocationGid))
        : allLocations;
    const targetLocations =
      selectedLocationId.length > 0
        ? visibleLocations.filter((l) => l.shopifyLocationGid === selectedLocationId)
        : visibleLocations;

    if (!access.allowed) {
      return {
        hasAccess: false,
        planMessage: access.message,
        view,
        targetDate,
        targetMonth,
        selectedLocationId,
        locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
        rows: [] as Array<Record<string, string | number | null>>,
        loadError: null as string | null,
      };
    }

    const validTargetLocations = targetLocations.filter(
      (l) => /^gid:\/\/shopify\/Location\/\d+$/.test(l.shopifyLocationGid)
    );
    if (validTargetLocations.length === 0) {
      return {
        hasAccess: true,
        planMessage: "",
        view,
        targetDate,
        targetMonth,
        selectedLocationId,
        locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
        rows: [] as Array<Record<string, string | number | null>>,
        loadError: null as string | null,
      };
    }

    if (view === "daily") {
      const rowsRaw = await Promise.all(
        validTargetLocations.map(async (loc) => {
          try {
            return await computeAndCacheDailySummary(admin, shop.id, loc.shopifyLocationGid, loc.name, targetDate);
          } catch {
            return null;
          }
        })
      );
      const rows = rowsRaw.filter((r): r is NonNullable<typeof r> => r !== null);
      return {
        hasAccess: true,
        planMessage: "",
        view,
        targetDate,
        targetMonth,
        selectedLocationId,
        locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
        rows,
        loadError: null as string | null,
      };
    }

    const { dateFrom, dateTo } = monthRange(targetMonth);
    for (const day of eachDay(dateFrom, dateTo)) {
      for (const loc of validTargetLocations) {
        try {
          await computeAndCacheDailySummary(admin, shop.id, loc.shopifyLocationGid, loc.name, day);
        } catch {
          // 1店舗の失敗で全体を落とさない
        }
      }
    }
    const cacheRows = await prisma.salesSummaryCacheDaily.findMany({
      where: {
        shopId: shop.id,
        locationId: { in: validTargetLocations.map((l) => l.shopifyLocationGid) },
        targetDate: { gte: dateFrom, lte: dateTo },
      },
    });
    const aggMap = new Map<string, { locationName: string; actual: number; budget: number | null; orders: number; items: number }>();
    for (const loc of validTargetLocations) {
      aggMap.set(loc.shopifyLocationGid, { locationName: loc.name, actual: 0, budget: 0, orders: 0, items: 0 });
    }
    for (const row of cacheRows) {
      const hit = aggMap.get(row.locationId);
      if (!hit) continue;
      hit.actual += Number(row.actual);
      hit.orders += row.orders;
      hit.items += row.items;
      if (row.budget !== null) hit.budget = (hit.budget ?? 0) + Number(row.budget);
    }
    const rows = Array.from(aggMap.entries()).map(([locationId, v]) => ({
      locationId,
      locationName: v.locationName,
      actual: v.actual,
      budget: v.budget,
      budgetRatio: v.budget && v.budget > 0 ? v.actual / v.budget : null,
      orders: v.orders,
      items: v.items,
    }));

    return {
      hasAccess: true,
      planMessage: "",
      view,
      targetDate,
      targetMonth,
      selectedLocationId,
      locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
      rows,
      loadError: null as string | null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "売上サマリーの読み込みに失敗しました";
    const today = new Date().toISOString().slice(0, 10);
    return {
      hasAccess: true,
      planMessage: "",
      view: "daily" as const,
      targetDate: today,
      targetMonth: today.slice(0, 7),
      selectedLocationId: "",
      locations: [] as Array<{ id: string; name: string }>,
      rows: [] as Array<Record<string, string | number | null>>,
      loadError: message,
    };
  }
}

export default function SalesSummaryAdminPage() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const tableRows = data.rows.map((r) => [
    String(r.locationName ?? ""),
    fmtYen((r.actual as number) ?? 0),
    fmtYen((r.budget as number | null) ?? null),
    fmtPct((r.budgetRatio as number | null) ?? null),
    `${Number(r.orders ?? 0).toLocaleString("ja-JP")}件`,
    `${Number(r.items ?? 0).toLocaleString("ja-JP")}点`,
  ]);

  return (
    <PolarisPageWrapper>
      <Page title="売上サマリー（管理画面）">
        <Card padding="0">
          <TabGroupBar tabs={REPORTS_TABS} />
        </Card>
        <Layout>
          {data.loadError && (
            <Layout.Section>
              <Banner tone="critical">売上サマリー読込エラー: {data.loadError}</Banner>
            </Layout.Section>
          )}
          {!data.hasAccess && (
            <Layout.Section>
              <Banner tone="warning">{data.planMessage}</Banner>
            </Layout.Section>
          )}
          {data.hasAccess && (
            <>
              <Layout.Section>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack gap="300" wrap>
                      <Select
                        label="表示"
                        options={[
                          { label: "日次", value: "daily" },
                          { label: "月次", value: "period" },
                        ]}
                        value={data.view}
                        onChange={(v) => setParam("view", v)}
                      />
                      {data.view === "daily" ? (
                        <Box minWidth="220px">
                          <input
                            type="date"
                            value={data.targetDate}
                            onChange={(e) => setParam("targetDate", e.currentTarget.value)}
                            style={{ width: "100%", padding: 8 }}
                          />
                        </Box>
                      ) : (
                        <Box minWidth="220px">
                          <input
                            type="month"
                            value={data.targetMonth}
                            onChange={(e) => setParam("targetMonth", e.currentTarget.value)}
                            style={{ width: "100%", padding: 8 }}
                          />
                        </Box>
                      )}
                      <Select
                        label="ロケーション"
                        options={[
                          { label: "全ロケーション", value: "" },
                          ...data.locations.map((l) => ({ label: l.name, value: l.id })),
                        ]}
                        value={data.selectedLocationId}
                        onChange={(v) => setParam("locationId", v)}
                      />
                    </InlineStack>
                    <Text tone="subdued" as="p">
                      管理画面では閲覧専用です（入店数報告入力はPOSタイル側で実施）。
                    </Text>
                  </BlockStack>
                </Card>
              </Layout.Section>
              <Layout.Section>
                <Card>
                  {tableRows.length === 0 ? (
                    <Text tone="subdued" as="p">表示対象データがありません。</Text>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
                      headings={["ロケーション", "実績", "予算", "予算比", "件数", "点数"]}
                      rows={tableRows}
                    />
                  )}
                </Card>
              </Layout.Section>
            </>
          )}
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}

