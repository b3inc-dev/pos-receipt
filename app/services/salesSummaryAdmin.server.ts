/** 管理画面の既存集計処理を独立した取得先へ移動。集計/キャッシュの計算は変更しない。 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, checkPlanAccess } from "../utils/planFeatures.server";
import { computeAndCacheDailySummary } from "./salesSummaryEngine.server";
import { autoDiscoverChannels, computeAndCacheChannelDailySummary, getEnabledSalesChannels } from "./salesChannelEngine.server";
import { buildLocationDayCacheSet, getSalesSummaryPeriodMaxComputes, needsLocationDayCompute } from "../utils/salesSummaryPeriodCache.server";
import { getLocationBudgetAmountsForDayBatch, sumLocationBudgetsForPeriodBatch } from "../utils/salesSummaryBudgetFromDb.server";
import { sumOptionalBudgetColumn } from "../utils/salesSummaryTotals";
import { getShopTimezoneForDaily, getCalendarDateStringInTimeZone, addCalendarDaysToIsoDate } from "../utils/shopTimezone.server";
type AdminClient = { graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<{json:()=>Promise<unknown>}> };
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
  debugMode: boolean = false,
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SALES_SUMMARY_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await computeAndCacheDailySummary(admin, shopId, locationGid, locationName, targetDate, {
        debug: debugMode,
      });
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

export async function loadAdminSalesSummary({ request }: LoaderFunctionArgs) {
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
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
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
        recomputeDebug: null,
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
        recomputeDebug: null,
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
      const wantDebug = forceRecomputeDaily === true;
      const recomputeDebugLocations: Array<unknown> = [];
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
          // 過去日のみ DB キャッシュを読む。当日は常に再計算（以前は「当日かつキャッシュあり」で再計算に到達せず数値が永遠に更新されない不具合があった）
          const useLocationDailyCache =
            Boolean(cached) && !forceRecomputeDaily && targetDate < today;
          if (useLocationDailyCache) {
            rowsRaw.push(toDailyRowFromCache(loc.shopifyLocationGid, loc.name, targetDate, cached));
            continue;
          }
          // 過去日はキャッシュ固定: キャッシュ未作成時のみ計算して埋める（recompute=1 のときは常に再計算）
          if (!shouldRecompute && !cached) {
            const computed = await computeWithRetry(
              admin,
              shop.id,
              loc.shopifyLocationGid,
              loc.name,
              targetDate,
              wantDebug
            );
            if (wantDebug && (computed as any)?.debug) recomputeDebugLocations.push(computed);
            rowsRaw.push(computed);
            continue;
          }
          // 当日/未来日(入力誤り含む)は最新化のため再計算
          const computed = await computeWithRetry(
            admin,
            shop.id,
            loc.shopifyLocationGid,
            loc.name,
            targetDate,
            wantDebug
          );
          if (wantDebug && (computed as any)?.debug) recomputeDebugLocations.push(computed);
          rowsRaw.push(computed);
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
          recomputeDebug: wantDebug ? { locations: recomputeDebugLocations } : null,
          locations: visibleLocations.map((l) => ({ id: l.shopifyLocationGid, name: l.name })),
          rows, channelRows: [],
          loadError: loadErrorDaily,
          loadWarning: null,
        };
      }
      await autoDiscoverChannels(admin, shop.id);
      const enabledChannels = await getEnabledSalesChannels(shop.id);
      const isPastDate = targetDate < today;
      const recomputeDebugChannels: Array<unknown> = [];
      const channelRows: Array<{
        channelId: string; channelName: string;
        actual: number; orders: number; items: number;
        budget: number | null; budgetRatio: number | null;
        atv: number | null; setRate: number | null; unit: number | null;
        debug?: unknown;
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
            admin,
            shop.id,
            ch.id,
            ch.displayName,
            ch.sourceNames,
            targetDate,
            { debug: wantDebug },
          );
          if (wantDebug && (row as any)?.debug) recomputeDebugChannels.push(row);
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
        recomputeDebug: wantDebug ? { locations: recomputeDebugLocations, channels: recomputeDebugChannels } : null,
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
      return redirect("/app/sales-summary" + next.search);
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
      recomputeDebug: null,
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
      recomputeDebug: null,
      locations: [] as Array<{ id: string; name: string }>,
      rows: [] as Array<Record<string, string | number | null>>,
      channelRows: [] as Array<Record<string, string | number | null>>,
      loadError: message,
      loadWarning: null,
    };
  }
}

