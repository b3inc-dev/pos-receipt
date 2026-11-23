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
import { shareWithinLoad } from "../utils/salesSummaryLoadShare.server";
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
  /**
   * cachedOnly のときだけ付く。保存済みの数字だけで組み立てたか。
   * false = どこかの店・チャネルに保存済みが無い（rows は空。画面は最新の数え直しを待つ）。
   */
  cacheComplete?: boolean;
  /** cachedOnly のときだけ付く。使った保存済みの中で一番古い保存時刻（ISO） */
  cachedAsOf?: string | null;
};

export type BuildDailySalesSummaryOptions = {
  /** 未指定時はショップの「今日」（タイムゾーン） */
  targetDate?: string | null;
  /** 空配列 = 全店（POS API と同じ） */
  locationIdsParam?: string[];
  forceRecompute?: boolean;
  /**
   * POS の 1 回の読み込みを表す ID。同じ ID の期間 API と「今日」の計算を共有する（数え方は同じ）。
   * 未指定なら共有しない。
   */
  loadId?: string | null;
  /**
   * true のときチャネル（オンライン等）の行を数えない。
   * POS の個店表示はチャネル行も合計も出さないため、その分の問い合わせを省く。
   */
  skipChannels?: boolean;
  /**
   * true のとき Shopify で数え直さず、保存済みの日次集計（webhook 等で更新済み）だけを返す。
   * POS の全店表示で「○時○分時点」の数字を先に出すため。数え方は変えない（保存済みを読むだけ）。
   */
  cachedOnly?: boolean;
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
  const loadId = options.loadId ?? null;
  const skipChannels = options.skipChannels === true;
  const cachedOnly = options.cachedOnly === true;

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

  if (cachedOnly) {
    return buildDailyPayloadFromCacheOnly({
      shopId: shop.id,
      targetDate,
      calendarToday: shopCalendarToday,
      merged,
      targetLocations,
      skipChannels,
    });
  }

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

    const row = await shareWithinLoad(loadId, `loc|${shop.id}|${locationGid}|${targetDate}`, () =>
      computeAndCacheDailySummary(admin, shop.id, locationGid, loc.name, targetDate),
    );
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

  if (!skipChannels) await autoDiscoverChannels(admin, shop.id);
  const enabledChannels = skipChannels ? [] : await getEnabledSalesChannels(shop.id);
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
    return shareWithinLoad(loadId, `ch|${shop.id}|${ch.id}|${targetDate}`, () =>
      computeAndCacheChannelDailySummary(admin, shop.id, ch.id, ch.displayName, ch.sourceNames, targetDate),
    );
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

/** 保存済みの日次集計だけで日次ペイロードを作る（Shopify は呼ばない） */
async function buildDailyPayloadFromCacheOnly(p: {
  shopId: string;
  targetDate: string;
  calendarToday: string;
  merged: ReturnType<typeof mergeAndNormalizeSalesSummarySettings>;
  targetLocations: SalesSummaryLocationRow[];
  skipChannels: boolean;
}): Promise<DailySalesSummaryPayload> {
  const { shopId, targetDate, calendarToday, merged, targetLocations } = p;
  const incomplete = (): DailySalesSummaryPayload => ({
    rows: [],
    channelRows: [],
    totals: { actual: 0, orders: 0, items: 0, budget: null, visitors: null },
    targetDate,
    calendarToday,
    displayOptions: merged,
    cacheComplete: false,
    cachedAsOf: null,
  });

  const idVariants: string[] = [];
  for (const l of targetLocations) {
    idVariants.push(l.shopifyLocationGid);
    const raw = l.shopifyLocationGid.replace("gid://shopify/Location/", "");
    if (raw) idVariants.push(raw);
  }
  const caches = await prisma.salesSummaryCacheDaily.findMany({
    where: { shopId, locationId: { in: idVariants }, targetDate },
  });
  let oldest: Date | null = null;
  const noteTime = (d: Date | null | undefined) => {
    if (d && (!oldest || d < oldest)) oldest = d;
  };

  const rowsBase: Array<DailySummaryRowDTO & { footfallReportingEnabled: boolean }> = [];
  for (const loc of targetLocations) {
    const gid = loc.shopifyLocationGid;
    const raw = gid.replace("gid://shopify/Location/", "");
    const cached = caches.find((c) => c.locationId === gid) ?? caches.find((c) => c.locationId === raw);
    if (!cached) return incomplete();
    noteTime(cached.updatedAt);
    rowsBase.push({
      locationId: gid,
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
      footfallReportingEnabled: isFootfallReportingAllowedForLocation(merged, gid),
    });
  }

  // 予算は数え直し時と同じく予算表から（保存済みの budget 列より新しい）
  const budgetByLocDay = await getLocationBudgetAmountsForDayBatch(
    shopId,
    rowsBase.map((r) => r.locationId),
    targetDate,
  );
  const rows = rowsBase.map((r) => {
    const budget = budgetByLocDay.get(r.locationId) ?? null;
    const budgetRatio = budget != null && budget > 0 ? r.actual / budget : null;
    return { ...r, budget, budgetRatio };
  });

  let channelRows: ChannelDailySummaryDTO[] = [];
  if (!p.skipChannels) {
    const enabledChannels = await getEnabledSalesChannels(shopId);
    if (enabledChannels.length > 0) {
      const chCaches = await prisma.salesChannelCacheDaily.findMany({
        where: { shopId, channelId: { in: enabledChannels.map((c) => c.id) }, targetDate },
      });
      for (const ch of enabledChannels) {
        const cached = chCaches.find((c) => c.channelId === ch.id);
        // チャネルの対象（source_name）が変わった後の保存済みは使わない（数え直し時と同じ条件）
        if (!cached || ch.sourceNamesJson !== ch.sourceNamesSnapshot) return incomplete();
        noteTime(cached.updatedAt);
        channelRows.push({
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
        });
      }
      const budgetByChannelDay = await getChannelBudgetAmountsForDayBatch(
        shopId,
        channelRows.map((r) => r.channelId),
        targetDate,
      );
      channelRows = channelRows.map((r) => {
        const budget = budgetByChannelDay.get(r.channelId) ?? null;
        const budgetRatio = budget != null && budget > 0 ? r.actual / budget : null;
        return { ...r, budget, budgetRatio };
      });
    }
  }

  const grandForBudget = [...rows, ...channelRows];
  const totals = {
    actual: rows.reduce((s, r) => s + r.actual, 0) + channelRows.reduce((s, r) => s + r.actual, 0),
    orders: rows.reduce((s, r) => s + r.orders, 0) + channelRows.reduce((s, r) => s + r.orders, 0),
    items: rows.reduce((s, r) => s + r.items, 0) + channelRows.reduce((s, r) => s + r.items, 0),
    budget: sumOptionalBudgetColumn(grandForBudget, "budget"),
    visitors: rows.some((r) => r.visitors !== null)
      ? rows.reduce((s, r) => s + (r.visitors ?? 0), 0)
      : null,
  };
  const asOf = oldest as Date | null;
  return {
    rows,
    channelRows,
    totals,
    targetDate,
    calendarToday,
    displayOptions: merged,
    cacheComplete: true,
    cachedAsOf: asOf ? asOf.toISOString() : null,
  };
}
