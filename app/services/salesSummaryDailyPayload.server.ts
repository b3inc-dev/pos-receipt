/**
 * 日次売上サマリーの JSON ペイロードを組み立てる（POS API / 公開リンクで共用）
 */
import prisma from "../db.server";
import { computeAndCacheDailySummary, type DailySummaryRowDTO } from "./salesSummaryEngine.server";
import {
  autoDiscoverChannels,
  computeAndCacheChannelDailySummary,
  getEnabledSalesChannels,
  type ChannelDailySummaryDTO,
} from "./salesChannelEngine.server";
import {
  getAppSetting,
  SALES_SUMMARY_SETTINGS_KEY,
  mergeAndNormalizeSalesSummarySettings,
  isFootfallReportingAllowedForLocation,
  type SalesSummarySettings,
} from "../utils/appSettings.server";
import {
  getChannelBudgetAmountsForDayBatch,
  getLocationBudgetAmountsForDayBatch,
} from "../utils/salesSummaryBudgetFromDb.server";
import { sumOptionalBudgetColumn } from "../utils/salesSummaryTotals";
import { getShopTimezoneForDaily, getCalendarDateStringInTimeZone } from "../utils/shopTimezone.server";
import type { Shop } from "@prisma/client";

type SalesSummaryAdmin = Parameters<typeof computeAndCacheDailySummary>[0];

type SalesSummaryLocationRow = Awaited<ReturnType<typeof prisma.location.findMany>>[number];

export type DailySalesSummaryPayload = {
  rows: Array<DailySummaryRowDTO & { footfallReportingEnabled: boolean }>;
  channelRows: ChannelDailySummaryDTO[];
  totals: {
    actual: number;
    orders: number;
    items: number;
    budget: number | null;
    visitors: number | null;
  };
  targetDate: string;
  calendarToday: string;
  displayOptions: ReturnType<typeof mergeAndNormalizeSalesSummarySettings>;
};

export type BuildDailySalesSummaryOptions = {
  /** 未指定時はショップの「今日」（タイムゾーン） */
  targetDate?: string | null;
  /** 空配列 = 全店（POS API と同じ） */
  locationIdsParam?: string[];
  forceRecompute?: boolean;
};

export async function buildDailySalesSummaryPayload(
  admin: SalesSummaryAdmin,
  shop: Pick<Shop, "id">,
  options: BuildDailySalesSummaryOptions = {},
): Promise<DailySalesSummaryPayload> {
  const shopIanaTz = await getShopTimezoneForDaily(admin, shop.id);
  const shopCalendarToday = getCalendarDateStringInTimeZone(new Date(), shopIanaTz);

  const settings = await getAppSetting<Partial<SalesSummarySettings>>(shop.id, SALES_SUMMARY_SETTINGS_KEY);
  const merged = mergeAndNormalizeSalesSummarySettings(settings ?? undefined);
  const targetDate = options.targetDate?.trim() || shopCalendarToday;
  const locationIdsParam = options.locationIdsParam ?? [];
  const forceRecompute = options.forceRecompute === true;

  const emptyPayload = (): DailySalesSummaryPayload => ({
    rows: [],
    channelRows: [],
    totals: { actual: 0, orders: 0, items: 0, budget: null, visitors: null },
    displayOptions: merged,
    targetDate,
    calendarToday: shopCalendarToday,
  });

  if (!merged.salesSummaryEnabled) {
    return emptyPayload();
  }

  let allLocations: SalesSummaryLocationRow[] = await prisma.location.findMany({
    where: { shopId: shop.id, salesSummaryEnabled: true },
  });

  if (allLocations.length === 0) {
    const locRes = await admin.graphql(`#graphql
        query { locations(first: 50, includeLegacy: false) { nodes { id name isActive } } }
      `);
    const locJson = (await locRes.json()) as {
      data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } };
    };
    const shopifyLocs = (locJson.data?.locations?.nodes ?? []).filter((l) => l.isActive);
    for (const loc of shopifyLocs) {
      await prisma.location.upsert({
        where: { shopId_shopifyLocationGid: { shopId: shop.id, shopifyLocationGid: loc.id } },
        update: { name: loc.name, salesSummaryEnabled: true },
        create: { shopId: shop.id, shopifyLocationGid: loc.id, name: loc.name, salesSummaryEnabled: true },
      });
    }
    allLocations = await prisma.location.findMany({
      where: { shopId: shop.id, salesSummaryEnabled: true },
    });
  }

  let targetLocations: SalesSummaryLocationRow[] =
    locationIdsParam.length > 0
      ? allLocations.filter((l: SalesSummaryLocationRow) => {
          const lNum = l.shopifyLocationGid.replace("gid://shopify/Location/", "");
          if (!lNum) return false;
          return locationIdsParam.some((id) => {
            const idNum = id.replace("gid://shopify/Location/", "");
            return lNum === idNum;
          });
        })
      : allLocations;

  if (merged.visibleLocationIds.length > 0) {
    targetLocations = targetLocations.filter((l: SalesSummaryLocationRow) =>
      merged.visibleLocationIds.includes(l.shopifyLocationGid),
    );
  }

  if (targetLocations.length === 0) {
    return emptyPayload();
  }

  const today = shopCalendarToday;
  const isPastDate = targetDate < today;

  const buildRow = async (
    loc: SalesSummaryLocationRow,
  ): Promise<DailySummaryRowDTO & { footfallReportingEnabled: boolean }> => {
    const locationGid = loc.shopifyLocationGid;
    const locationRawId = locationGid.replace("gid://shopify/Location/", "");

    if (isPastDate && !forceRecompute) {
      const cached = await prisma.salesSummaryCacheDaily.findFirst({
        where: {
          shopId: shop.id,
          locationId: { in: [locationGid, locationRawId] },
          targetDate,
        },
      });

      if (cached) {
        const cachedRow: DailySummaryRowDTO = {
          locationId: locationGid,
          locationName: loc.name,
          targetDate,
          actual: Number(cached.actual),
          orders: cached.orders,
          items: cached.items,
          visitors: cached.visitors,
          budget: cached.budget !== null ? Number(cached.budget) : null,
          budgetRatio: cached.budgetRatio !== null ? Number(cached.budgetRatio) : null,
          conv: cached.conv !== null ? Number(cached.conv) : null,
          atv: cached.atv !== null ? Number(cached.atv) : null,
          setRate: cached.setRate !== null ? Number(cached.setRate) : null,
          unit: cached.unit !== null ? Number(cached.unit) : null,
          currency: "JPY",
        };
        return {
          ...cachedRow,
          footfallReportingEnabled: isFootfallReportingAllowedForLocation(merged, locationGid),
        };
      }
    }

    const row = await computeAndCacheDailySummary(admin, shop.id, locationGid, loc.name, targetDate);
    return {
      ...row,
      footfallReportingEnabled: isFootfallReportingAllowedForLocation(merged, locationGid),
    };
  };

  const useSequentialToday = !isPastDate && targetLocations.length > 1;
  let rows: Array<DailySummaryRowDTO & { footfallReportingEnabled: boolean }>;
  if (useSequentialToday) {
    rows = [];
    for (const loc of targetLocations) {
      rows.push(await buildRow(loc));
    }
  } else {
    rows = await Promise.all(targetLocations.map((loc) => buildRow(loc)));
  }

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

  await autoDiscoverChannels(admin, shop.id);
  const enabledChannels = await getEnabledSalesChannels(shop.id);
  const buildChannelRow = async (
    ch: Awaited<ReturnType<typeof getEnabledSalesChannels>>[number],
  ): Promise<ChannelDailySummaryDTO> => {
    if (isPastDate && !forceRecompute) {
      const cached = await prisma.salesChannelCacheDaily.findFirst({
        where: { shopId: shop.id, channelId: ch.id, targetDate },
      });
      if (cached && ch.sourceNamesJson === ch.sourceNamesSnapshot) {
        return {
          channelId: ch.id,
          channelName: ch.displayName,
          targetDate,
          actual: Number(cached.actual),
          orders: cached.orders,
          items: cached.items,
          budget: cached.budget !== null ? Number(cached.budget) : null,
          budgetRatio: cached.budgetRatio !== null ? Number(cached.budgetRatio) : null,
          atv: cached.atv !== null ? Number(cached.atv) : null,
          setRate: cached.setRate !== null ? Number(cached.setRate) : null,
          unit: cached.unit !== null ? Number(cached.unit) : null,
          currency: cached.currency,
        };
      }
    }
    return computeAndCacheChannelDailySummary(admin, shop.id, ch.id, ch.displayName, ch.sourceNames, targetDate);
  };

  let channelRows: ChannelDailySummaryDTO[] = [];
  if (enabledChannels.length > 0) {
    if (!isPastDate && enabledChannels.length > 1) {
      for (const ch of enabledChannels) {
        channelRows.push(await buildChannelRow(ch));
      }
    } else {
      channelRows = await Promise.all(enabledChannels.map(buildChannelRow));
    }
  }

  const budgetByChannelDay = await getChannelBudgetAmountsForDayBatch(
    shop.id,
    channelRows.map((r) => r.channelId),
    targetDate,
  );
  channelRows = channelRows.map((r) => {
    const budget = budgetByChannelDay.get(r.channelId) ?? null;
    const budgetRatio = budget != null && budget > 0 ? r.actual / budget : null;
    return { ...r, budget, budgetRatio };
  });

  const grandForBudget = [...rows, ...channelRows];
  const budget = sumOptionalBudgetColumn(grandForBudget, "budget");
  const totals = {
    actual: rows.reduce((s, r) => s + r.actual, 0) + channelRows.reduce((s, r) => s + r.actual, 0),
    orders: rows.reduce((s, r) => s + r.orders, 0) + channelRows.reduce((s, r) => s + r.orders, 0),
    items: rows.reduce((s, r) => s + r.items, 0) + channelRows.reduce((s, r) => s + r.items, 0),
    budget,
    visitors: rows.some((r) => r.visitors !== null)
      ? rows.reduce((s, r) => s + (r.visitors ?? 0), 0)
      : null,
  };

  return {
    rows,
    channelRows,
    totals,
    targetDate,
    calendarToday: shopCalendarToday,
    displayOptions: merged,
  };
}
