/**
 * 売上サマリー月次ロールアップ（SalesSummaryCachePeriod / SalesChannelCachePeriod）
 * - Webhook 後に日次キャッシュから集計して upsert
 * - 期間 API で再計算不要かつ条件一致時は DB 1読み相当で返す（高速パス）
 */
import prisma from "../db.server";
import {
  expandLocationIdsForBudgetQuery,
  sumChannelBudgetsForPeriodBatch,
  sumLocationBudgetsForPeriodBatch,
} from "../utils/salesSummaryBudgetFromDb.server";
import { sumOptionalBudgetColumn } from "../utils/salesSummaryTotals";
import { addCalendarDaysToIsoDate } from "../utils/shopTimezone.server";

export type RollupAdmin = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

type LocRow = {
  locationId: string;
  locationName: string;
  actualTotal: number;
  budgetTotal: number | null;
  orders: number;
  items: number;
  visitors: number | null;
  progressBudgetToday: number;
  progressBudgetPrev: number;
  achievementRate: number | null;
  progressRateToday: number | null;
  progressRatePrev: number | null;
  conv: number | null;
  atv: number | null;
  setRate: number | null;
  unit: number | null;
};

type ChRow = {
  channelId: string;
  channelName: string;
  actualTotal: number;
  budgetTotal: number | null;
  orders: number;
  items: number;
  progressBudgetToday: number;
  progressBudgetPrev: number;
  achievementRate: number | null;
  progressRateToday: number | null;
  progressRatePrev: number | null;
};

/** periodKey YYYY-MM からその月の最終暦日 YYYY-MM-DD */
export function lastCalendarDayOfMonthKey(periodKey: string): string | null {
  const [y, m] = periodKey.split("-").map((v) => parseInt(v, 10));
  if (!y || !m || m < 1 || m > 12) return null;
  const last = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

function dedupeDailyByDate<T extends { targetDate: string; updatedAt: Date }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) {
    const prev = m.get(r.targetDate);
    if (!prev || r.updatedAt > prev.updatedAt) m.set(r.targetDate, r);
  }
  return m;
}

function aggregateLocationDaily(
  shopId: string,
  locationGid: string,
  dateFrom: string,
  actualEndDate: string,
): Promise<{ actual: number; orders: number; items: number; visitors: number | null }> {
  const variants = expandLocationIdsForBudgetQuery(locationGid);
  return prisma.salesSummaryCacheDaily
    .findMany({
      where: {
        shopId,
        locationId: { in: variants },
        targetDate: { gte: dateFrom, lte: actualEndDate },
      },
    })
    .then((rows) => {
      const byD = dedupeDailyByDate(rows);
      let actual = 0;
      let orders = 0;
      let items = 0;
      let visitors: number | null = null;
      for (const r of byD.values()) {
        actual += Number(r.actual);
        orders += r.orders;
        items += r.items;
        if (r.visitors !== null) {
          visitors = (visitors ?? 0) + r.visitors;
        }
      }
      return { actual, orders, items, visitors };
    });
}

function aggregateChannelDaily(
  shopId: string,
  channelId: string,
  dateFrom: string,
  actualEndDate: string,
): Promise<{ actual: number; orders: number; items: number }> {
  return prisma.salesChannelCacheDaily
    .findMany({
      where: {
        shopId,
        channelId,
        targetDate: { gte: dateFrom, lte: actualEndDate },
      },
    })
    .then((rows) => {
      const byD = dedupeDailyByDate(rows);
      let actual = 0;
      let orders = 0;
      let items = 0;
      for (const r of byD.values()) {
        actual += Number(r.actual);
        orders += r.orders;
        items += r.items;
      }
      return { actual, orders, items };
    });
}

function toLocRow(
  locationId: string,
  locationName: string,
  actual: number,
  orders: number,
  items: number,
  visitors: number | null,
  budgetTotal: number | null,
  progressBudgetToday: number,
  progressBudgetPrev: number,
): LocRow {
  return {
    locationId,
    locationName,
    actualTotal: actual,
    budgetTotal,
    orders,
    items,
    visitors,
    progressBudgetToday,
    progressBudgetPrev,
    achievementRate: budgetTotal && budgetTotal > 0 ? actual / budgetTotal : null,
    progressRateToday: progressBudgetToday > 0 ? actual / progressBudgetToday : null,
    progressRatePrev: progressBudgetPrev > 0 ? actual / progressBudgetPrev : null,
    conv: visitors !== null && visitors > 0 ? orders / visitors : null,
    atv: orders > 0 ? actual / orders : null,
    setRate: orders > 0 ? items / orders : null,
    unit: items > 0 ? actual / items : null,
  };
}

function toChRow(
  channelId: string,
  channelName: string,
  actual: number,
  orders: number,
  items: number,
  budgetTotal: number | null,
  progressBudgetToday: number,
  progressBudgetPrev: number,
): ChRow {
  return {
    channelId,
    channelName,
    actualTotal: actual,
    budgetTotal,
    orders,
    items,
    progressBudgetToday,
    progressBudgetPrev,
    achievementRate: budgetTotal && budgetTotal > 0 ? actual / budgetTotal : null,
    progressRateToday: progressBudgetToday > 0 ? actual / progressBudgetToday : null,
    progressRatePrev: progressBudgetPrev > 0 ? actual / progressBudgetPrev : null,
  };
}

/**
 * 1 ショップ・1 暦月のロールアップを日次キャッシュ＋予算DBから再構築して upsert。
 */
export async function syncSalesSummaryRollupsForMonthSlice(
  shopId: string,
  periodKey: string,
  dateFrom: string,
  actualEndDate: string,
  budgetRangeEnd: string,
  progressCutoff: string,
  progressPrevCutoff: string,
  locations: { shopifyLocationGid: string; name: string }[],
  channels: { id: string; displayName: string }[],
): Promise<void> {
  const last = lastCalendarDayOfMonthKey(periodKey);
  if (!last || dateFrom !== `${periodKey}-01`) return;
  if (actualEndDate < dateFrom || budgetRangeEnd < dateFrom) return;

  const locGids = locations.map((l) => l.shopifyLocationGid);
  const periodBudgetByLoc = await sumLocationBudgetsForPeriodBatch(
    shopId,
    locGids,
    dateFrom,
    budgetRangeEnd,
    progressCutoff,
    progressPrevCutoff,
  );

  for (const loc of locations) {
    const gid = loc.shopifyLocationGid;
    const agg = await aggregateLocationDaily(shopId, gid, dateFrom, actualEndDate);
    const pb = periodBudgetByLoc.get(gid);
    const budgetTotal = pb?.budgetTotal ?? null;
    const progressBudgetToday = pb?.progressBudgetToday ?? 0;
    const progressBudgetPrev = pb?.progressBudgetPrev ?? 0;

    await prisma.salesSummaryCachePeriod.upsert({
      where: {
        shopId_locationId_periodType_periodKey: {
          shopId,
          locationId: gid,
          periodType: "month",
          periodKey,
        },
      },
      create: {
        shopId,
        locationId: gid,
        periodType: "month",
        periodKey,
        startDate: dateFrom,
        endDate: actualEndDate,
        budgetRangeEnd,
        progressCutoffUsed: progressCutoff,
        actualTotal: agg.actual,
        ordersTotal: agg.orders,
        itemsTotal: agg.items,
        visitorsTotal: agg.visitors,
        budgetTotal,
        progressBudgetToday,
        progressBudgetPrev,
      },
      update: {
        startDate: dateFrom,
        endDate: actualEndDate,
        budgetRangeEnd,
        progressCutoffUsed: progressCutoff,
        actualTotal: agg.actual,
        ordersTotal: agg.orders,
        itemsTotal: agg.items,
        visitorsTotal: agg.visitors,
        budgetTotal,
        progressBudgetToday,
        progressBudgetPrev,
      },
    });
  }

  if (channels.length === 0) return;

  const periodBudgetByCh = await sumChannelBudgetsForPeriodBatch(
    shopId,
    channels.map((c) => c.id),
    dateFrom,
    budgetRangeEnd,
    progressCutoff,
    progressPrevCutoff,
  );

  for (const ch of channels) {
    const agg = await aggregateChannelDaily(shopId, ch.id, dateFrom, actualEndDate);
    const pb = periodBudgetByCh.get(ch.id);
    const budgetTotal = pb?.budgetTotal ?? null;
    const progressBudgetToday = pb?.progressBudgetToday ?? 0;
    const progressBudgetPrev = pb?.progressBudgetPrev ?? 0;

    await prisma.salesChannelCachePeriod.upsert({
      where: {
        shopId_channelId_periodKey: { shopId, channelId: ch.id, periodKey },
      },
      create: {
        shopId,
        channelId: ch.id,
        periodType: "month",
        periodKey,
        startDate: dateFrom,
        endDate: actualEndDate,
        budgetRangeEnd,
        progressCutoffUsed: progressCutoff,
        actualTotal: agg.actual,
        ordersTotal: agg.orders,
        itemsTotal: agg.items,
        budgetTotal,
        progressBudgetToday,
        progressBudgetPrev,
      },
      update: {
        startDate: dateFrom,
        endDate: actualEndDate,
        budgetRangeEnd,
        progressCutoffUsed: progressCutoff,
        actualTotal: agg.actual,
        ordersTotal: agg.orders,
        itemsTotal: agg.items,
        budgetTotal,
        progressBudgetToday,
        progressBudgetPrev,
      },
    });
  }
}

/**
 * Webhook で触れた暦日から、該当する暦月のロールアップを更新する。
 */
export async function syncRollupsAfterTargetDates(
  shopId: string,
  shopCalendarToday: string,
  targetDates: string[],
  locations: { shopifyLocationGid: string; name: string }[],
  channels: { id: string; displayName: string }[],
): Promise<void> {
  const unique = [...new Set(targetDates)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (unique.length === 0) return;

  const monthKeys = new Set(unique.map((d) => d.slice(0, 7)));

  for (const periodKey of monthKeys) {
    const monthStart = `${periodKey}-01`;
    const monthLast = lastCalendarDayOfMonthKey(periodKey);
    if (!monthLast) continue;

    const isCurrentMonth = periodKey === shopCalendarToday.slice(0, 7);

    let actualEnd: string;
    if (isCurrentMonth) {
      actualEnd = shopCalendarToday <= monthLast ? shopCalendarToday : monthLast;
    } else {
      actualEnd = monthLast;
    }

    const progressCutoff =
      shopCalendarToday < actualEnd ? shopCalendarToday : actualEnd;
    const progressPrevCutoff = addCalendarDaysToIsoDate(progressCutoff, -1);

    await syncSalesSummaryRollupsForMonthSlice(
      shopId,
      periodKey,
      monthStart,
      actualEnd,
      monthLast,
      progressCutoff,
      progressPrevCutoff,
      locations,
      channels,
    );
  }
}

export type TryRollupParams = {
  shopId: string;
  dateFrom: string;
  dateTo: string;
  budgetRangeTo: string;
  progressCutoff: string;
  progressPrevCutoff: string;
  locationGids: string[];
  locationNames: Map<string, string>;
  channels: { id: string; displayName: string }[];
};

/**
 * 期間 API と同じ前提（暦月の 1 日始まり・endDate / budgetRangeEnd / progressCutoff が一致）で
 * ロールアップが揃っていれば集計結果を返す。否则 null。
 */
export async function tryLoadPeriodAggregatesFromRollup(
  p: TryRollupParams,
): Promise<{ rows: LocRow[]; channelRows: ChRow[]; totals: Record<string, unknown> } | null> {
  const { shopId, dateFrom, dateTo, budgetRangeTo, progressCutoff } = p;
  if (!/^\d{4}-\d{2}-01$/.test(dateFrom)) return null;
  const pk = dateFrom.slice(0, 7);
  if (!dateTo.startsWith(pk)) return null;

  const locRoll = await prisma.salesSummaryCachePeriod.findMany({
    where: {
      shopId,
      periodType: "month",
      periodKey: pk,
      locationId: { in: p.locationGids },
      startDate: dateFrom,
      endDate: dateTo,
      budgetRangeEnd: budgetRangeTo,
      progressCutoffUsed: progressCutoff,
    },
  });

  if (locRoll.length !== p.locationGids.length) return null;
  const byLoc = new Map(locRoll.map((r) => [r.locationId, r]));
  for (const gid of p.locationGids) {
    if (!byLoc.has(gid)) return null;
  }

  const rows: LocRow[] = p.locationGids.map((gid) => {
    const r = byLoc.get(gid)!;
    const name = p.locationNames.get(gid) ?? gid;
    const actual = Number(r.actualTotal);
    const orders = r.ordersTotal;
    const items = r.itemsTotal;
    const visitors = r.visitorsTotal;
    const budgetTotal = r.budgetTotal !== null ? Number(r.budgetTotal) : null;
    const pt = Number(r.progressBudgetToday ?? 0);
    const pp = Number(r.progressBudgetPrev ?? 0);
    return toLocRow(gid, name, actual, orders, items, visitors, budgetTotal, pt, pp);
  });

  let channelRows: ChRow[] = [];
  if (p.channels.length > 0) {
    const chRoll = await prisma.salesChannelCachePeriod.findMany({
      where: {
        shopId,
        periodKey: pk,
        startDate: dateFrom,
        endDate: dateTo,
        budgetRangeEnd: budgetRangeTo,
        progressCutoffUsed: progressCutoff,
        channelId: { in: p.channels.map((c) => c.id) },
      },
    });
    if (chRoll.length !== p.channels.length) return null;
    const byCh = new Map(chRoll.map((r) => [r.channelId, r]));
    for (const c of p.channels) {
      if (!byCh.has(c.id)) return null;
    }
    channelRows = p.channels.map((c) => {
      const r = byCh.get(c.id)!;
      const actual = Number(r.actualTotal);
      const orders = r.ordersTotal;
      const items = r.itemsTotal;
      const budgetTotal = r.budgetTotal !== null ? Number(r.budgetTotal) : null;
      const pt = Number(r.progressBudgetToday ?? 0);
      const pp = Number(r.progressBudgetPrev ?? 0);
      return toChRow(c.id, c.displayName, actual, orders, items, budgetTotal, pt, pp);
    });
  }

  const storeOrders = rows.reduce((s, r) => s + r.orders, 0);
  const storeVisitors = rows.some((r) => r.visitors !== null)
    ? rows.reduce((s, r) => s + (r.visitors ?? 0), 0)
    : null;
  const totalActual =
    rows.reduce((s, r) => s + r.actualTotal, 0) +
    channelRows.reduce((s, r) => s + r.actualTotal, 0);
  const totalOrders =
    rows.reduce((s, r) => s + r.orders, 0) + channelRows.reduce((s, r) => s + r.orders, 0);
  const totalItems =
    rows.reduce((s, r) => s + r.items, 0) + channelRows.reduce((s, r) => s + r.items, 0);

  const grandForBudget = [...rows, ...channelRows];
  const budgetTotal = sumOptionalBudgetColumn(
    grandForBudget as { budgetTotal: number | null }[],
    "budgetTotal",
  );
  const progressBudgetToday =
    rows.reduce((s, r) => s + r.progressBudgetToday, 0) +
    channelRows.reduce((s, r) => s + r.progressBudgetToday, 0);
  const progressBudgetPrev =
    rows.reduce((s, r) => s + r.progressBudgetPrev, 0) +
    channelRows.reduce((s, r) => s + r.progressBudgetPrev, 0);

  const totals = {
    actualTotal: totalActual,
    budgetTotal,
    progressBudgetToday,
    progressBudgetPrev,
    orders: totalOrders,
    items: totalItems,
    visitors: storeVisitors,
    conv: storeVisitors !== null && storeVisitors > 0 ? storeOrders / storeVisitors : null,
    atv: totalOrders > 0 ? totalActual / totalOrders : null,
    setRate: totalOrders > 0 ? totalItems / totalOrders : null,
    unit: totalItems > 0 ? totalActual / totalItems : null,
  };

  return { rows, channelRows, totals };
}

/** 期間APIリクエストと同じ暦月スライスでロールアップを更新（POS 利用後の整合用・非同期で可） */
export async function syncRollupsMatchingPeriodRequest(
  shopId: string,
  dateFrom: string,
  dateTo: string,
  budgetRangeTo: string,
  progressCutoff: string,
  progressPrevCutoff: string,
  locations: { shopifyLocationGid: string; name: string }[],
  channels: { id: string; displayName: string }[],
): Promise<void> {
  if (!/^\d{4}-\d{2}-01$/.test(dateFrom)) return;
  const pk = dateFrom.slice(0, 7);
  if (!dateTo.startsWith(pk)) return;
  await syncSalesSummaryRollupsForMonthSlice(
    shopId,
    pk,
    dateFrom,
    dateTo,
    budgetRangeTo,
    progressCutoff,
    progressPrevCutoff,
    locations,
    channels,
  );
}
