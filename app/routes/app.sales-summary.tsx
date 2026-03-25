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

type AdminClient = {
  graphql: (query: string) => Promise<{ json: () => Promise<unknown> }>;
};

async function syncActiveLocationsForSalesSummary(admin: AdminClient, shopId: string) {
  const locRes = await admin.graphql(`#graphql
    query {
      locations(first: 250, includeLegacy: false) {
        nodes {
          id
          name
          isActive
        }
      }
    }
  `);
  const locJson = (await locRes.json()) as {
    data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } };
  };
  const activeLocations = (locJson.data?.locations?.nodes ?? []).filter((l) => l.isActive);

  for (const loc of activeLocations) {
    await prisma.location.upsert({
      where: { shopId_shopifyLocationGid: { shopId, shopifyLocationGid: loc.id } },
      // 既存設定を壊さないため、有効/無効フラグは既存値を維持する
      update: { name: loc.name },
      create: { shopId, shopifyLocationGid: loc.id, name: loc.name, salesSummaryEnabled: true },
    });
  }
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "不明なエラー";
}

function parseEnvInt(name: string, fallback: number, min = 1, max = 10000): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

const SALES_SUMMARY_RETRY_MAX_ATTEMPTS = parseEnvInt(
  "SALES_SUMMARY_RETRY_MAX_ATTEMPTS",
  3,
  1,
  10,
);
const SALES_SUMMARY_RETRY_BASE_DELAY_MS = parseEnvInt(
  "SALES_SUMMARY_RETRY_BASE_DELAY_MS",
  300,
  50,
  10000,
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLocationIdCandidates(locationGid: string): string[] {
  const raw = locationGid.replace("gid://shopify/Location/", "");
  return raw ? [locationGid, raw] : [locationGid];
}

function canRetrySummaryError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("throttle") ||
    m.includes("429") ||
    m.includes("rate limit") ||
    m.includes("timeout") ||
    m.includes("temporar") ||
    m.includes("internal server error")
  );
}

async function computeWithRetry(
  admin: Parameters<typeof computeAndCacheDailySummary>[0],
  shopId: string,
  locationGid: string,
  locationName: string,
  targetDate: string,
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SALES_SUMMARY_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await computeAndCacheDailySummary(admin, shopId, locationGid, locationName, targetDate);
    } catch (err) {
      lastError = err;
      const msg = toErrorMessage(err);
      if (attempt >= SALES_SUMMARY_RETRY_MAX_ATTEMPTS || !canRetrySummaryError(msg)) break;
      await sleep(SALES_SUMMARY_RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

function toDailyRowFromCache(
  locationId: string,
  locationName: string,
  targetDate: string,
  cache: {
    actual: unknown;
    orders: number;
    items: number;
    visitors: number | null;
    budget: unknown;
    budgetRatio: unknown;
    conv: unknown;
    atv: unknown;
    setRate: unknown;
    unit: unknown;
  },
) {
  return {
    locationId,
    locationName,
    targetDate,
    actual: Number(cache.actual),
    orders: cache.orders,
    items: cache.items,
    visitors: cache.visitors,
    budget: cache.budget != null ? Number(cache.budget) : null,
    budgetRatio: cache.budgetRatio != null ? Number(cache.budgetRatio) : null,
    conv: cache.conv != null ? Number(cache.conv) : null,
    atv: cache.atv != null ? Number(cache.atv) : null,
    setRate: cache.setRate != null ? Number(cache.setRate) : null,
    unit: cache.unit != null ? Number(cache.unit) : null,
    currency: "JPY",
  };
}

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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

    let syncWarning: string | null = null;
    try {
      await syncActiveLocationsForSalesSummary(admin, shop.id);
    } catch {
      syncWarning = "ロケーション同期に失敗したため、DB登録済みデータのみ表示しています。";
    }

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
      const failedLocationErrors = new Map<string, string>();
      const today = todayStr();
      const shouldRecompute = targetDate >= today;
      const rowsRaw: Array<Awaited<ReturnType<typeof computeAndCacheDailySummary>> | null> = [];
      for (const loc of validTargetLocations) {
        try {
          const candidates = buildLocationIdCandidates(loc.shopifyLocationGid);
          const cached = await prisma.salesSummaryCacheDaily.findFirst({
            where: {
              shopId: shop.id,
              locationId: { in: candidates },
              targetDate,
            },
            orderBy: { updatedAt: "desc" },
          });
          if (cached) {
            rowsRaw.push(toDailyRowFromCache(loc.shopifyLocationGid, loc.name, targetDate, cached));
            continue;
          }
          // 過去日はキャッシュ固定: キャッシュ未作成時のみ計算して埋める
          if (!shouldRecompute && !cached) {
            rowsRaw.push(await computeWithRetry(admin, shop.id, loc.shopifyLocationGid, loc.name, targetDate));
            continue;
          }
          // 当日/未来日(入力誤り含む)は最新化のため再計算
          rowsRaw.push(await computeWithRetry(admin, shop.id, loc.shopifyLocationGid, loc.name, targetDate));
        } catch (err) {
          failedLocationErrors.set(loc.name, toErrorMessage(err));
          rowsRaw.push(null);
        }
      }
      const rows = rowsRaw.filter((r): r is NonNullable<typeof r> => r !== null);
      const failedDetails = Array.from(failedLocationErrors.entries()).map(
        ([name, reason]) => `${name}: ${reason}`
      );
      const loadErrorParts = [
        syncWarning,
        failedDetails.length > 0
          ? `一部ロケーションの集計に失敗しました（${failedDetails.join(" / ")}）。`
          : null,
      ].filter((v): v is string => Boolean(v));
      return {
        hasAccess: true,
        planMessage: "",
        view,
        targetDate,
        targetMonth,
        selectedLocationId,
        locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
        rows,
        loadError: loadErrorParts.length > 0 ? loadErrorParts.join(" ") : null,
      };
    }

    const { dateFrom, dateTo } = monthRange(targetMonth);
    const failedLocationErrors = new Map<string, string>();
    const today = todayStr();
    for (const day of eachDay(dateFrom, dateTo)) {
      for (const loc of validTargetLocations) {
        try {
          const candidates = buildLocationIdCandidates(loc.shopifyLocationGid);
          const cached = await prisma.salesSummaryCacheDaily.findFirst({
            where: {
              shopId: shop.id,
              locationId: { in: candidates },
              targetDate: day,
            },
            select: { id: true },
          });
          // 月次は過去日をキャッシュ固定。当日以降のみ最新化のため再計算。
          const shouldRecompute = day >= today;
          if (!cached || shouldRecompute) {
            await computeWithRetry(admin, shop.id, loc.shopifyLocationGid, loc.name, day);
          }
        } catch (err) {
          // 月次は日ごとに同じ店舗が失敗し得るため、最初の理由のみ保持
          if (!failedLocationErrors.has(loc.name)) {
            failedLocationErrors.set(loc.name, toErrorMessage(err));
          }
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
    const failedDetails = Array.from(failedLocationErrors.entries()).map(
      ([name, reason]) => `${name}: ${reason}`
    );
    const loadErrorParts = [
      syncWarning,
      failedDetails.length > 0
        ? `一部ロケーションの集計に失敗しました（${failedDetails.join(" / ")}）。`
        : null,
    ].filter((v): v is string => Boolean(v));

    return {
      hasAccess: true,
      planMessage: "",
      view,
      targetDate,
      targetMonth,
      selectedLocationId,
      locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
      rows,
      loadError: loadErrorParts.length > 0 ? loadErrorParts.join(" ") : null,
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

