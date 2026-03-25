/**
 * /app/sales-summary — 管理画面用 売上サマリー（閲覧専用）
 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import { useMemo } from "react";
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
  Button,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, checkPlanAccess } from "../utils/planFeatures.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import {
  autoDiscoverChannels,
  computeAndCacheChannelDailySummary,
  getEnabledSalesChannels,
} from "../services/salesChannelEngine.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, REPORTS_TABS } from "../components/TabGroupBar";
import {
  buildLocationDayCacheSet,
  getSalesSummaryPeriodMaxComputes,
  needsLocationDayCompute,
} from "../utils/salesSummaryPeriodCache.server";
import {
  getLocationBudgetAmountsForDayBatch,
  sumLocationBudgetsForPeriodBatch,
} from "../utils/salesSummaryBudgetFromDb.server";
import {
  getShopTimezoneForDaily,
  getCalendarDateStringInTimeZone,
  addCalendarDaysToIsoDate,
} from "../utils/shopTimezone.server";

type AdminClient = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<{ json: () => Promise<unknown> }>;
};

type LocationRow = Awaited<ReturnType<typeof prisma.location.findMany>>[number];

/** 日次キャッシュの locationId が GID / 数値のどちらでもクエリにヒットするよう列挙 */
function expandLocationIdsForCacheQuery(targetLocations: LocationRow[]): string[] {
  const s = new Set<string>();
  for (const l of targetLocations) {
    const g = l.shopifyLocationGid;
    const raw = g.replace("gid://shopify/Location/", "");
    s.add(g);
    if (raw) s.add(raw);
  }
  return [...s];
}

/** キャッシュ行の locationId を店舗マスタ上の正規 GID に寄せる（期間集計のキーぶれ防止） */
function resolveCanonicalLocationGid(targetLocations: LocationRow[], rowLocationId: string): string | null {
  for (const l of targetLocations) {
    const g = l.shopifyLocationGid;
    const raw = g.replace("gid://shopify/Location/", "");
    if (rowLocationId === g || rowLocationId === raw) return g;
  }
  return null;
}

async function syncActiveLocationsForSalesSummary(admin: AdminClient, shopId: string) {
  const activeLocations: { id: string; name: string; isActive: boolean }[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let guard = 0;
  while (hasNextPage && guard < 100) {
    guard += 1;
    const locRes = await admin.graphql(
      `#graphql
      query LocationsSync($first: Int!, $after: String) {
        locations(first: $first, after: $after, includeLegacy: false) {
          nodes {
            id
            name
            isActive
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
      { variables: { first: 100, after: cursor } },
    );
    const locJson = (await locRes.json()) as {
      data?: {
        locations?: {
          nodes?: { id: string; name: string; isActive: boolean }[];
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };
    const nodes = locJson.data?.locations?.nodes ?? [];
    const pageInfo = locJson.data?.locations?.pageInfo;
    // アクティブ／非アクティブどちらもマスタに載せ、管理画面で取りこぼさない
    activeLocations.push(...nodes);
    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
  }

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

/** ロケーション同期警告＋一部ロケーション失敗を1本の loadError 文字列にまとめる（const 配列の TDZ を避けるため明示的に組み立てる） */
function buildLocationFailureLoadError(
  syncWarning: string | null,
  failedDetails: string[],
): string | null {
  const parts: string[] = [];
  if (syncWarning) parts.push(syncWarning);
  if (failedDetails.length > 0) {
    parts.push(
      `一部ロケーションの集計に失敗しました（${failedDetails.join(" / ")}）。`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
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
function fmtDecimal(n: number | null, decimals: number) {
  if (n === null || n === undefined) return "-";
  return Number(n).toLocaleString("ja-JP", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 日次合計セルを生成する（visitorsを持たない行は visitors=null として扱われる） */
function buildDailyTotalRowCells(rows: Array<Record<string, unknown>>, label = "POS合計"): string[] | null {
  if (rows.length === 0) return null;
  let actual = 0, orders = 0, items = 0, visitorsAcc = 0, budgetSum = 0;
  let haveVisitors = false, allBudget = true;
  for (const r of rows) {
    actual += Number(r.actual ?? 0);
    orders += Number(r.orders ?? 0);
    items += Number(r.items ?? 0);
    if (r.budget === null || r.budget === undefined) allBudget = false;
    else budgetSum += Number(r.budget);
    if (r.visitors != null) { haveVisitors = true; visitorsAcc += Number(r.visitors); }
  }
  const budget = allBudget ? budgetSum : null;
  const budgetRatio = budget != null && budget > 0 ? actual / budget : null;
  const visitors = haveVisitors ? visitorsAcc : null;
  const conv = visitors != null && visitors > 0 ? orders / visitors : null;
  const atv = orders > 0 ? actual / orders : null;
  const setRate = orders > 0 ? items / orders : null;
  const unit = items > 0 ? actual / items : null;
  return [
    label,
    fmtYen(actual),
    budget != null ? fmtYen(budget) : "-",
    fmtPct(budgetRatio),
    `${orders.toLocaleString("ja-JP")}件`,
    visitors != null ? `${visitors.toLocaleString("ja-JP")}人` : "-",
    fmtPct(conv),
    fmtYen(atv),
    fmtDecimal(setRate, 2),
    `${items.toLocaleString("ja-JP")}点`,
    fmtYen(unit),
  ];
}

/** 月次合計セルを生成する */
function buildPeriodTotalRowCells(rows: Array<Record<string, unknown>>, label = "POS合計"): string[] | null {
  if (rows.length === 0) return null;
  let actualTotal = 0, orders = 0, items = 0;
  let progressBudgetToday = 0, progressBudgetPrev = 0, budgetSum = 0;
  let visitorsAcc = 0, haveVisitors = false, allBudget = true;
  for (const r of rows) {
    actualTotal += Number(r.actualTotal ?? 0);
    orders += Number(r.orders ?? 0);
    items += Number(r.items ?? 0);
    progressBudgetToday += Number(r.progressBudgetToday ?? 0);
    progressBudgetPrev += Number(r.progressBudgetPrev ?? 0);
    if (r.budgetTotal === null || r.budgetTotal === undefined) allBudget = false;
    else budgetSum += Number(r.budgetTotal);
    if (r.visitors != null) { haveVisitors = true; visitorsAcc += Number(r.visitors); }
  }
  const budgetTotal = allBudget ? budgetSum : null;
  const achievementRate = budgetTotal != null && budgetTotal > 0 ? actualTotal / budgetTotal : null;
  const progressRateToday = progressBudgetToday > 0 ? actualTotal / progressBudgetToday : null;
  const progressRatePrev = progressBudgetPrev > 0 ? actualTotal / progressBudgetPrev : null;
  const visitors = haveVisitors ? visitorsAcc : null;
  const conv = visitors != null && visitors > 0 ? orders / visitors : null;
  const atv = orders > 0 ? actualTotal / orders : null;
  const setRate = orders > 0 ? items / orders : null;
  const unit = items > 0 ? actualTotal / items : null;
  return [
    label,
    fmtYen(actualTotal),
    budgetTotal != null ? fmtYen(budgetTotal) : "-",
    fmtPct(achievementRate),
    progressBudgetToday > 0 ? fmtYen(progressBudgetToday) : "-",
    fmtPct(progressRateToday),
    progressBudgetPrev > 0 ? fmtYen(progressBudgetPrev) : "-",
    fmtPct(progressRatePrev),
    `${orders.toLocaleString("ja-JP")}件`,
    visitors != null ? `${visitors.toLocaleString("ja-JP")}人` : "-",
    fmtPct(conv),
    fmtYen(atv),
    fmtDecimal(setRate, 2),
    `${items.toLocaleString("ja-JP")}点`,
    fmtYen(unit),
  ];
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
    const shopIanaTz = await getShopTimezoneForDaily(admin, shop.id);
    const shopCalendarToday = getCalendarDateStringInTimeZone(new Date(), shopIanaTz);
    const fullAccess = await getFullAccess(admin, session);
    const access = checkPlanAccess(shop.planCode, "sales_summary", fullAccess);

    const url = new URL(request.url);
    const view = url.searchParams.get("view") === "period" ? "period" : "daily";
    const targetDate = url.searchParams.get("targetDate") ?? shopCalendarToday;
    const targetMonth = url.searchParams.get("targetMonth") ?? targetDate.slice(0, 7);
    const selectedLocationId = url.searchParams.get("locationId") ?? "";
    const showChannels = url.searchParams.get("showChannels") !== "0";
    const forceRecomputeDaily = url.searchParams.get("recompute") === "1";
    const forceRecomputeChannelMonth = url.searchParams.get("recomputeChannelMonth") === "1";

    let syncWarning: string | null = null;
    try {
      await syncActiveLocationsForSalesSummary(admin, shop.id);
    } catch {
      syncWarning = "ロケーション同期に失敗したため、DB登録済みデータのみ表示しています。";
    }

    // 管理画面は Shopify 上の全店舗を一覧できるよう、salesSummaryEnabled で除外しない
    const allLocations = await prisma.location.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
    });
    // 管理画面は閲覧用のため、POS 向けの visibleLocationIds では絞り込まない（全ロケーションを表示）
    const visibleLocations = allLocations;
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
        showChannels,
        calendarToday: shopCalendarToday,
        recomputeDailyApplied: false,
        recomputeChannelMonthApplied: false,
        locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
        rows: [] as Array<Record<string, string | number | null>>,
        channelRows: [] as Array<Record<string, string | number | null>>,
        loadError: null as string | null,
        loadWarning: null as string | null,
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
        showChannels,
        calendarToday: shopCalendarToday,
        recomputeDailyApplied: false,
        recomputeChannelMonthApplied: false,
        locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
        rows: [] as Array<Record<string, string | number | null>>,
        channelRows: [] as Array<Record<string, string | number | null>>,
        loadError: null as string | null,
        loadWarning: null as string | null,
      };
    }

    if (view === "daily") {
      const failedLocationErrors = new Map<string, string>();
      const today = shopCalendarToday;
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
          const skipLocationCache = targetDate < today && forceRecomputeDaily;
          if (cached && !skipLocationCache) {
            rowsRaw.push(toDailyRowFromCache(loc.shopifyLocationGid, loc.name, targetDate, cached));
            continue;
          }
          // 過去日はキャッシュ固定: キャッシュ未作成時のみ計算して埋める（recompute=1 のときは常に再計算）
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
      let rows = rowsRaw.filter((r): r is NonNullable<typeof r> => r !== null);

      const budgetByLocDay = await getLocationBudgetAmountsForDayBatch(
        shop.id,
        rows.map((r) => r.locationId),
        targetDate,
      );
      rows = rows.map((r) => {
        const budget = budgetByLocDay.get(r.locationId) ?? null;
        const budgetRatio = budget != null && budget > 0 ? r.actual / budget : null;
        return { ...r, budget, budgetRatio };
      });

      const failedDetailsDaily = Array.from(failedLocationErrors.entries()).map(
        ([name, reason]) => `${name}: ${reason}`,
      );
      const loadErrorDaily = buildLocationFailureLoadError(syncWarning, failedDetailsDaily);

      // ── チャネル行集計（daily） ──────────────────────────────────────────────
      if (!showChannels) {
        return {
          hasAccess: true, planMessage: "", view, targetDate, targetMonth,
          selectedLocationId, showChannels,
          calendarToday: shopCalendarToday,
          recomputeDailyApplied: forceRecomputeDaily,
          recomputeChannelMonthApplied: false,
          locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
          rows, channelRows: [],
          loadError: loadErrorDaily,
          loadWarning: null,
        };
      }
      await autoDiscoverChannels(admin, shop.id);
      const enabledChannels = await getEnabledSalesChannels(shop.id);
      const isPastDate = targetDate < today;
      const channelRows: Array<{
        channelId: string; channelName: string;
        actual: number; orders: number; items: number;
        budget: number | null; budgetRatio: number | null;
        atv: number | null; setRate: number | null; unit: number | null;
      }> = [];
      for (const ch of enabledChannels) {
        try {
          if (isPastDate && !forceRecomputeDaily) {
            const cached = await prisma.salesChannelCacheDaily.findFirst({
              where: { shopId: shop.id, channelId: ch.id, targetDate },
            });
            if (cached && ch.sourceNamesJson === ch.sourceNamesSnapshot) {
              channelRows.push({
                channelId: ch.id, channelName: ch.displayName,
                actual: Number(cached.actual), orders: cached.orders, items: cached.items,
                budget: cached.budget !== null ? Number(cached.budget) : null,
                budgetRatio: cached.budgetRatio !== null ? Number(cached.budgetRatio) : null,
                atv: cached.atv !== null ? Number(cached.atv) : null,
                setRate: cached.setRate !== null ? Number(cached.setRate) : null,
                unit: cached.unit !== null ? Number(cached.unit) : null,
              });
              continue;
            }
          }
          const row = await computeAndCacheChannelDailySummary(
            admin, shop.id, ch.id, ch.displayName, ch.sourceNames, targetDate
          );
          channelRows.push({ channelId: ch.id, channelName: ch.displayName, ...row });
        } catch { /* チャネル1件の失敗で全体を落とさない */ }
      }

      return {
        hasAccess: true,
        planMessage: "",
        view,
        targetDate,
        targetMonth,
        selectedLocationId,
        showChannels,
        calendarToday: shopCalendarToday,
        recomputeDailyApplied: forceRecomputeDaily,
        recomputeChannelMonthApplied: false,
        locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
        rows,
        channelRows,
        loadError: loadErrorDaily,
        loadWarning: null,
      };
    }

    const { dateFrom, dateTo } = monthRange(targetMonth);
    const channelMonthRebuildNotice =
      url.searchParams.get("channelNotice") === "channelMonthRebuilt";
    if (forceRecomputeChannelMonth && showChannels) {
      await prisma.salesChannelCacheDaily.deleteMany({
        where: { shopId: shop.id, targetDate: { gte: dateFrom, lte: dateTo } },
      });
      const next = new URL(request.url);
      next.searchParams.delete("recomputeChannelMonth");
      next.searchParams.set("channelNotice", "channelMonthRebuilt");
      return redirect(next.pathname + next.search);
    }
    const failedLocationErrors = new Map<string, string>();
    const today = shopCalendarToday;
    const locationIdsForQuery = expandLocationIdsForCacheQuery(validTargetLocations);
    const daysInMonth = eachDay(dateFrom, dateTo);

    const prefetchLocationCaches = await prisma.salesSummaryCacheDaily.findMany({
      where: {
        shopId: shop.id,
        locationId: { in: locationIdsForQuery },
        targetDate: { gte: dateFrom, lte: dateTo },
      },
      select: { locationId: true, targetDate: true },
    });
    const locationCacheSet = buildLocationDayCacheSet(
      prefetchLocationCaches,
      validTargetLocations,
      resolveCanonicalLocationGid,
    );

    const locationWork: Array<{ day: string; loc: LocationRow }> = [];
    for (const day of daysInMonth) {
      for (const loc of validTargetLocations) {
        if (!needsLocationDayCompute(day, loc.shopifyLocationGid, today, locationCacheSet)) continue;
        locationWork.push({ day, loc });
      }
    }
    locationWork.sort(
      (a, b) => a.day.localeCompare(b.day) || a.loc.name.localeCompare(b.loc.name),
    );

    const maxPeriod = getSalesSummaryPeriodMaxComputes();
    let budget = maxPeriod === 0 ? Number.MAX_SAFE_INTEGER : maxPeriod;
    let locationAttempts = 0;
    for (const { day, loc } of locationWork) {
      if (budget <= 0) break;
      locationAttempts += 1;
      try {
        await computeWithRetry(admin, shop.id, loc.shopifyLocationGid, loc.name, day);
      } catch (err) {
        if (!failedLocationErrors.has(loc.name)) {
          failedLocationErrors.set(loc.name, toErrorMessage(err));
        }
      }
      budget -= 1;
    }
    const skippedLocation = Math.max(0, locationWork.length - locationAttempts);

    const cacheRows = await prisma.salesSummaryCacheDaily.findMany({
      where: {
        shopId: shop.id,
        locationId: { in: locationIdsForQuery },
        targetDate: { gte: dateFrom, lte: dateTo },
      },
    });
    const todayStrForPeriod = shopCalendarToday;
    const yesterdayStrForPeriod = addCalendarDaysToIsoDate(shopCalendarToday, -1);
    const locationMap = new Map<
      string,
      {
        locationId: string;
        locationName: string;
        actualTotal: number;
        budgetTotal: number | null;
        orders: number;
        items: number;
        visitors: number | null;
        progressBudgetToday: number;
        progressBudgetPrev: number;
      }
    >();
    for (const loc of validTargetLocations) {
      locationMap.set(loc.shopifyLocationGid, {
        locationId: loc.shopifyLocationGid,
        locationName: loc.name,
        actualTotal: 0,
        budgetTotal: null,
        orders: 0,
        items: 0,
        visitors: null,
        progressBudgetToday: 0,
        progressBudgetPrev: 0,
      });
    }
    for (const row of cacheRows) {
      const canon = resolveCanonicalLocationGid(validTargetLocations, row.locationId);
      if (!canon) continue;
      const entry = locationMap.get(canon);
      if (!entry) continue;
      entry.actualTotal += Number(row.actual);
      entry.orders += row.orders;
      entry.items += row.items;
      if (row.visitors !== null) {
        entry.visitors = (entry.visitors ?? 0) + row.visitors;
      }
    }

    const periodBudgetByLoc = await sumLocationBudgetsForPeriodBatch(
      shop.id,
      validTargetLocations.map((l) => l.shopifyLocationGid),
      dateFrom,
      dateTo,
      todayStrForPeriod,
      yesterdayStrForPeriod,
    );
    for (const loc of validTargetLocations) {
      const entry = locationMap.get(loc.shopifyLocationGid);
      if (!entry) continue;
      const pb = periodBudgetByLoc.get(loc.shopifyLocationGid);
      if (!pb) continue;
      entry.budgetTotal = pb.budgetTotal;
      entry.progressBudgetToday = pb.progressBudgetToday;
      entry.progressBudgetPrev = pb.progressBudgetPrev;
    }

    const rows = Array.from(locationMap.values()).map((entry) => ({
      locationId: entry.locationId,
      locationName: entry.locationName,
      actualTotal: entry.actualTotal,
      budgetTotal: entry.budgetTotal,
      achievementRate:
        entry.budgetTotal && entry.budgetTotal > 0 ? entry.actualTotal / entry.budgetTotal : null,
      progressBudgetToday: entry.progressBudgetToday,
      progressRateToday:
        entry.progressBudgetToday > 0 ? entry.actualTotal / entry.progressBudgetToday : null,
      progressBudgetPrev: entry.progressBudgetPrev,
      progressRatePrev:
        entry.progressBudgetPrev > 0 ? entry.actualTotal / entry.progressBudgetPrev : null,
      orders: entry.orders,
      items: entry.items,
      visitors: entry.visitors,
      conv:
        entry.visitors !== null && entry.visitors > 0 ? entry.orders / entry.visitors : null,
      atv: entry.orders > 0 ? entry.actualTotal / entry.orders : null,
      setRate: entry.orders > 0 ? entry.items / entry.orders : null,
      unit: entry.items > 0 ? entry.actualTotal / entry.items : null,
    }));

    const failedDetailsPeriodEarly = Array.from(failedLocationErrors.entries()).map(
      ([name, reason]) => `${name}: ${reason}`,
    );
    const loadErrorPeriod = buildLocationFailureLoadError(syncWarning, failedDetailsPeriodEarly);

    const loadWarningPeriodOnly =
      maxPeriod !== 0 && skippedLocation > 0
        ? `月次表示では1回の読み込みで実行する計算件数に上限があります（残りおおよそ${skippedLocation}件）。ページを再読み込みすると続きが埋まります。まとめて取得する場合はアプリのバックフィル画面で月単位の取得が使えます。`
        : null;

    // ── チャネル行集計（period） ─────────────────────────────────────────────
    if (!showChannels) {
      return {
        hasAccess: true, planMessage: "", view, targetDate, targetMonth,
        selectedLocationId, showChannels,
        calendarToday: shopCalendarToday,
        recomputeDailyApplied: false,
        recomputeChannelMonthApplied: channelMonthRebuildNotice,
        locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
        rows, channelRows: [],
        loadError: loadErrorPeriod,
        loadWarning: loadWarningPeriodOnly,
      };
    }
    await autoDiscoverChannels(admin, shop.id);
    const enabledChannelsPeriod = await getEnabledSalesChannels(shop.id);
    const prefetchChannelCaches =
      enabledChannelsPeriod.length === 0
        ? []
        : await prisma.salesChannelCacheDaily.findMany({
            where: {
              shopId: shop.id,
              channelId: { in: enabledChannelsPeriod.map((c) => c.id) },
              targetDate: { gte: dateFrom, lte: dateTo },
            },
            select: { channelId: true, targetDate: true },
          });
    const channelCachePresence = new Set(
      prefetchChannelCaches.map((r) => `${r.channelId}|${r.targetDate}`),
    );

    type EnabledCh = (typeof enabledChannelsPeriod)[number];
    const channelWork: Array<{ day: string; ch: EnabledCh }> = [];
    for (const day of daysInMonth) {
      const shouldRecompute = day >= todayStrForPeriod;
      for (const ch of enabledChannelsPeriod) {
        const hasCache = channelCachePresence.has(`${ch.id}|${day}`);
        if (!shouldRecompute && hasCache) continue;
        channelWork.push({ day, ch });
      }
    }
    channelWork.sort(
      (a, b) =>
        a.day.localeCompare(b.day) || a.ch.displayName.localeCompare(b.ch.displayName),
    );

    let channelAttempts = 0;
    for (const { day, ch } of channelWork) {
      if (budget <= 0) break;
      channelAttempts += 1;
      try {
        await computeAndCacheChannelDailySummary(
          admin, shop.id, ch.id, ch.displayName, ch.sourceNames, day
        );
      } catch { /* 1日1チャネルの失敗で全体を落とさない */ }
      budget -= 1;
    }
    const skippedChannel = Math.max(0, channelWork.length - channelAttempts);
    const skippedTotal = skippedLocation + skippedChannel;
    const loadWarning =
      maxPeriod !== 0 && skippedTotal > 0
        ? `月次表示では1回の読み込みで実行する計算件数に上限があります（残りおおよそ${skippedTotal}件）。ページを再読み込みすると続きが埋まります。まとめて取得する場合はアプリのバックフィル画面で月単位の取得が使えます。`
        : null;
    const channelCacheRows =
      enabledChannelsPeriod.length === 0
        ? []
        : await prisma.salesChannelCacheDaily.findMany({
            where: {
              shopId: shop.id,
              channelId: { in: enabledChannelsPeriod.map((c) => c.id) },
              targetDate: { gte: dateFrom, lte: dateTo },
            },
          });
    const channelMap = new Map<string, {
      channelId: string; channelName: string;
      actualTotal: number; budgetTotal: number | null;
      orders: number; items: number;
      progressBudgetToday: number; progressBudgetPrev: number;
    }>();
    for (const ch of enabledChannelsPeriod) {
      channelMap.set(ch.id, {
        channelId: ch.id, channelName: ch.displayName,
        actualTotal: 0, budgetTotal: null, orders: 0, items: 0,
        progressBudgetToday: 0, progressBudgetPrev: 0,
      });
    }
    for (const row of channelCacheRows) {
      const entry = channelMap.get(row.channelId);
      if (!entry) continue;
      entry.actualTotal += Number(row.actual);
      entry.orders += row.orders;
      entry.items += row.items;
      if (row.budget !== null) {
        entry.budgetTotal = (entry.budgetTotal ?? 0) + Number(row.budget);
        if (row.targetDate <= todayStrForPeriod) entry.progressBudgetToday += Number(row.budget);
        if (row.targetDate <= yesterdayStrForPeriod) entry.progressBudgetPrev += Number(row.budget);
      }
    }
    const channelRows = Array.from(channelMap.values()).map((entry) => ({
      channelId: entry.channelId,
      channelName: entry.channelName,
      actualTotal: entry.actualTotal,
      budgetTotal: entry.budgetTotal,
      achievementRate: entry.budgetTotal && entry.budgetTotal > 0 ? entry.actualTotal / entry.budgetTotal : null,
      progressBudgetToday: entry.progressBudgetToday,
      progressRateToday: entry.progressBudgetToday > 0 ? entry.actualTotal / entry.progressBudgetToday : null,
      progressBudgetPrev: entry.progressBudgetPrev,
      progressRatePrev: entry.progressBudgetPrev > 0 ? entry.actualTotal / entry.progressBudgetPrev : null,
      orders: entry.orders,
      items: entry.items,
      atv: entry.orders > 0 ? entry.actualTotal / entry.orders : null,
      setRate: entry.orders > 0 ? entry.items / entry.orders : null,
      unit: entry.items > 0 ? entry.actualTotal / entry.items : null,
    }));

    return {
      hasAccess: true,
      planMessage: "",
      view,
      targetDate,
      targetMonth,
      selectedLocationId,
      showChannels,
      calendarToday: shopCalendarToday,
      recomputeDailyApplied: false,
      recomputeChannelMonthApplied: channelMonthRebuildNotice,
      locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
      rows,
      channelRows,
      loadError: loadErrorPeriod,
      loadWarning,
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
      showChannels: true,
      calendarToday: today,
      recomputeDailyApplied: false,
      recomputeChannelMonthApplied: false,
      locations: [] as Array<{ id: string; name: string }>,
      rows: [] as Array<Record<string, string | number | null>>,
      channelRows: [] as Array<Record<string, string | number | null>>,
      loadError: message,
      loadWarning: null,
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

  const tableRows = useMemo(() => {
    if (!data.hasAccess) return [];
    const locationBody =
      data.view === "daily"
        ? data.rows.map((r) => [
            String(r.locationName ?? ""),
            fmtYen((r.actual as number) ?? 0),
            fmtYen((r.budget as number | null) ?? null),
            fmtPct((r.budgetRatio as number | null) ?? null),
            `${Number(r.orders ?? 0).toLocaleString("ja-JP")}件`,
            r.visitors != null ? `${Number(r.visitors).toLocaleString("ja-JP")}人` : "-",
            fmtPct((r.conv as number | null) ?? null),
            fmtYen((r.atv as number | null) ?? null),
            fmtDecimal((r.setRate as number | null) ?? null, 2),
            `${Number(r.items ?? 0).toLocaleString("ja-JP")}点`,
            fmtYen((r.unit as number | null) ?? null),
          ])
        : data.rows.map((r) => [
            String(r.locationName ?? ""),
            fmtYen((r.actualTotal as number) ?? 0),
            r.budgetTotal != null ? fmtYen(Number(r.budgetTotal)) : "-",
            fmtPct((r.achievementRate as number | null) ?? null),
            (r.progressBudgetToday as number) > 0 ? fmtYen(Number(r.progressBudgetToday)) : "-",
            fmtPct((r.progressRateToday as number | null) ?? null),
            (r.progressBudgetPrev as number) > 0 ? fmtYen(Number(r.progressBudgetPrev)) : "-",
            fmtPct((r.progressRatePrev as number | null) ?? null),
            `${Number(r.orders ?? 0).toLocaleString("ja-JP")}件`,
            r.visitors != null ? `${Number(r.visitors).toLocaleString("ja-JP")}人` : "-",
            fmtPct((r.conv as number | null) ?? null),
            fmtYen((r.atv as number | null) ?? null),
            fmtDecimal((r.setRate as number | null) ?? null, 2),
            `${Number(r.items ?? 0).toLocaleString("ja-JP")}点`,
            fmtYen((r.unit as number | null) ?? null),
          ]);

    const channelRows = data.channelRows ?? [];

    // チャネル行（POS以外のチャネル集計）
    const channelBody =
      data.view === "daily"
        ? channelRows.map((r) => [
            `[${String(r.channelName ?? "")}]`,
            fmtYen((r.actual as number) ?? 0),
            fmtYen((r.budget as number | null) ?? null),
            fmtPct((r.budgetRatio as number | null) ?? null),
            `${Number(r.orders ?? 0).toLocaleString("ja-JP")}件`,
            "-", "-",
            fmtYen((r.atv as number | null) ?? null),
            fmtDecimal((r.setRate as number | null) ?? null, 2),
            `${Number(r.items ?? 0).toLocaleString("ja-JP")}点`,
            fmtYen((r.unit as number | null) ?? null),
          ])
        : channelRows.map((r) => [
            `[${String(r.channelName ?? "")}]`,
            fmtYen((r.actualTotal as number) ?? 0),
            r.budgetTotal != null ? fmtYen(Number(r.budgetTotal)) : "-",
            fmtPct((r.achievementRate as number | null) ?? null),
            (r.progressBudgetToday as number) > 0 ? fmtYen(Number(r.progressBudgetToday)) : "-",
            fmtPct((r.progressRateToday as number | null) ?? null),
            (r.progressBudgetPrev as number) > 0 ? fmtYen(Number(r.progressBudgetPrev)) : "-",
            fmtPct((r.progressRatePrev as number | null) ?? null),
            `${Number(r.orders ?? 0).toLocaleString("ja-JP")}件`,
            "-", "-",
            fmtYen((r.atv as number | null) ?? null),
            fmtDecimal((r.setRate as number | null) ?? null, 2),
            `${Number(r.items ?? 0).toLocaleString("ja-JP")}点`,
            fmtYen((r.unit as number | null) ?? null),
          ]);

    // 各合計行
    const posRows = data.rows as Array<Record<string, unknown>>;
    const chRows = channelRows as Array<Record<string, unknown>>;
    const grandRows = [...posRows, ...chRows];

    const posTotal = data.view === "daily"
      ? buildDailyTotalRowCells(posRows, "POS合計")
      : buildPeriodTotalRowCells(posRows, "POS合計");
    const channelTotal = channelBody.length > 0
      ? (data.view === "daily"
          ? buildDailyTotalRowCells(chRows, "チャネル合計")
          : buildPeriodTotalRowCells(chRows, "チャネル合計"))
      : null;
    const grandTotal = channelBody.length > 0 && locationBody.length > 0
      ? (data.view === "daily"
          ? buildDailyTotalRowCells(grandRows, "総合計")
          : buildPeriodTotalRowCells(grandRows, "総合計"))
      : null;

    // テーブル行を構築
    // チャネルあり: 総合計 → POS合計 → POS行 → チャネル合計 → チャネル行
    // チャネルなし: POS合計 → POS行
    const result: string[][] = [];
    if (channelBody.length > 0) {
      if (grandTotal) result.push(grandTotal);
      if (posTotal && locationBody.length > 0) result.push(posTotal);
      result.push(...locationBody);
      if (channelTotal) result.push(channelTotal);
      result.push(...channelBody);
    } else {
      if (posTotal && locationBody.length > 0) result.push(posTotal);
      result.push(...locationBody);
    }
    return result;
  }, [data.hasAccess, data.view, data.rows, data.channelRows]);

  const dailyHeadings = [
    "ロケーション",
    "実績",
    "予算",
    "予算比",
    "件数",
    "入店数",
    "購買率",
    "客単価",
    "セット率",
    "点数",
    "一品単価",
  ];
  const periodHeadings = [
    "ロケーション",
    "月実績",
    "月予算",
    "達成率",
    "遂行予算(当日)",
    "遂行率(当日)",
    "遂行予算(前日)",
    "遂行率(前日)",
    "件数",
    "入店数",
    "購買率",
    "客単価",
    "セット率",
    "点数",
    "一品単価",
  ];

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
          {data.loadWarning && (
            <Layout.Section>
              <Banner tone="warning">{data.loadWarning}</Banner>
            </Layout.Section>
          )}
          {data.hasAccess && data.recomputeDailyApplied && (
            <Layout.Section>
              <Banner tone="success">
                この日の店舗行とチャネル行を、保存済みのキャッシュを使わずに取り直しました。次にページを開くときは、またキャッシュが使われます。
              </Banner>
              <Box paddingBlockStart="200">
                <Button
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete("recompute");
                    setSearchParams(next);
                  }}
                >
                  通常表示に戻す
                </Button>
              </Box>
            </Layout.Section>
          )}
          {data.hasAccess && data.recomputeChannelMonthApplied && (
            <Layout.Section>
              <Banner tone="success">
                表示中の月について、チャネル用の日ごとの保存データをいったん消してから集計し直しました。月次の店舗行は従来どおりです。
              </Banner>
              <Box paddingBlockStart="200">
                <Button
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete("channelNotice");
                    setSearchParams(next);
                  }}
                >
                  通常表示に戻す
                </Button>
              </Box>
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
                      <Select
                        label="チャネル行"
                        options={[
                          { label: "表示する", value: "1" },
                          { label: "非表示", value: "0" },
                        ]}
                        value={data.showChannels ? "1" : "0"}
                        onChange={(v) => setParam("showChannels", v)}
                      />
                      {data.view === "daily" && data.targetDate < data.calendarToday && (
                        <Button
                          variant="secondary"
                          onClick={() => setParam("recompute", "1")}
                        >
                          この日を再取得（古い保存を使わない）
                        </Button>
                      )}
                      {data.view === "period" && data.showChannels && (
                        <Button
                          variant="secondary"
                          onClick={() => setParam("recomputeChannelMonth", "1")}
                        >
                          この月のチャネルだけ保存を消してやり直す
                        </Button>
                      )}
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
                    <Box overflowX="scroll" maxWidth="100%">
                      <DataTable
                        columnContentTypes={
                          data.view === "daily"
                            ? (["text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric"] as const)
                            : (["text", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric", "numeric"] as const)
                        }
                        headings={data.view === "daily" ? dailyHeadings : periodHeadings}
                        rows={tableRows}
                      />
                    </Box>
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

