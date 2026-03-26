/**
 * 売上サマリーの「予算」表示・期間合算を Budget テーブル基準にそろえる。
 * 日次キャッシュは再計算されない過去日でも、予算だけ後から登録されるため、
 * キャッシュ上の budget に依存すると月合算が欠ける。ここで DB を正とする。
 */
import prisma from "../db.server";

export type LocationPeriodBudgetFromDb = {
  budgetTotal: number | null;
  progressBudgetToday: number;
  progressBudgetPrev: number;
};

/** computeAndCacheDailySummary / 予算管理と同じく GID・数値の両方で Budget を引けるようにする */
export function expandLocationIdsForBudgetQuery(shopifyLocationGid: string): string[] {
  const out = new Set<string>();
  if (shopifyLocationGid) out.add(shopifyLocationGid);
  const gid = shopifyLocationGid.startsWith("gid://")
    ? shopifyLocationGid
    : `gid://shopify/Location/${shopifyLocationGid}`;
  out.add(gid);
  const raw = gid.replace("gid://shopify/Location/", "");
  if (raw) out.add(raw);
  return [...out];
}

/**
 * 複数ロケーション・1ヶ月分を1クエリで取得し、店舗ごとに期間合計・遂行予算を算出する。
 */
export async function sumLocationBudgetsForPeriodBatch(
  shopId: string,
  locationGids: string[],
  dateFrom: string,
  dateTo: string,
  todayCutoff: string,
  yesterdayCutoff: string,
): Promise<Map<string, LocationPeriodBudgetFromDb>> {
  const result = new Map<string, LocationPeriodBudgetFromDb>();
  if (locationGids.length === 0) return result;

  const gidToVariants = new Map<string, string[]>();
  const allVariants = new Set<string>();
  for (const g of locationGids) {
    const v = expandLocationIdsForBudgetQuery(g);
    gidToVariants.set(g, v);
    for (const x of v) allVariants.add(x);
  }

  const rows = await prisma.budget.findMany({
    where: {
      shopId,
      locationId: { in: [...allVariants] },
      targetDate: { gte: dateFrom, lte: dateTo },
    },
    select: { locationId: true, targetDate: true, amount: true },
  });

  const byGidDate = new Map<string, Map<string, number>>();
  for (const g of locationGids) {
    byGidDate.set(g, new Map());
  }

  for (const r of rows) {
    for (const g of locationGids) {
      if (gidToVariants.get(g)!.includes(r.locationId)) {
        const dm = byGidDate.get(g)!;
        if (!dm.has(r.targetDate)) {
          dm.set(r.targetDate, Number(r.amount));
        }
        break;
      }
    }
  }

  for (const g of locationGids) {
    const dm = byGidDate.get(g)!;
    if (dm.size === 0) {
      result.set(g, { budgetTotal: null, progressBudgetToday: 0, progressBudgetPrev: 0 });
      continue;
    }
    let budgetTotal = 0;
    let progressBudgetToday = 0;
    let progressBudgetPrev = 0;
    for (const [targetDate, amt] of dm) {
      budgetTotal += amt;
      if (targetDate <= todayCutoff) progressBudgetToday += amt;
      if (targetDate <= yesterdayCutoff) progressBudgetPrev += amt;
    }
    result.set(g, { budgetTotal, progressBudgetToday, progressBudgetPrev });
  }

  return result;
}

/**
 * 同一日・複数ロケーション分の予算を1クエリで取得（日次API・管理画面日次用）
 */
export async function getLocationBudgetAmountsForDayBatch(
  shopId: string,
  locationGids: string[],
  targetDate: string,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (locationGids.length === 0) return result;

  const gidToVariants = new Map<string, string[]>();
  const allVariants = new Set<string>();
  for (const g of locationGids) {
    const v = expandLocationIdsForBudgetQuery(g);
    gidToVariants.set(g, v);
    for (const x of v) allVariants.add(x);
  }

  const rows = await prisma.budget.findMany({
    where: {
      shopId,
      locationId: { in: [...allVariants] },
      targetDate,
    },
    select: { locationId: true, amount: true },
  });

  for (const g of locationGids) {
    const vars = gidToVariants.get(g)!;
    const matches = rows.filter((r) => vars.includes(r.locationId));
    if (matches.length === 0) {
      result.set(g, null);
      continue;
    }
    let maxAmt = Number(matches[0].amount);
    for (let i = 1; i < matches.length; i++) {
      maxAmt = Math.max(maxAmt, Number(matches[i].amount));
    }
    result.set(g, maxAmt);
  }

  return result;
}

/**
 * 単一ロケーションの月内 Budget を日付→金額で返す（month-daily API 用）
 */
export async function getBudgetAmountsByDateForLocation(
  shopId: string,
  locationGid: string,
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, number>> {
  const variants = expandLocationIdsForBudgetQuery(locationGid);
  const rows = await prisma.budget.findMany({
    where: {
      shopId,
      locationId: { in: variants },
      targetDate: { gte: dateFrom, lte: dateTo },
    },
    select: { targetDate: true, amount: true },
  });
  const byDate = new Map<string, number>();
  for (const r of rows) {
    if (!byDate.has(r.targetDate)) {
      byDate.set(r.targetDate, Number(r.amount));
    }
  }
  return byDate;
}

/**
 * 複数チャネル・同一日の予算を1クエリで取得（日次API用）
 */
export async function getChannelBudgetAmountsForDayBatch(
  shopId: string,
  channelIds: string[],
  targetDate: string,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (channelIds.length === 0) return result;

  const rows = await prisma.salesChannelBudget.findMany({
    where: {
      shopId,
      channelId: { in: channelIds },
      targetDate,
    },
    select: { channelId: true, amount: true },
  });
  const byCh = new Map(rows.map((r) => [r.channelId, Number(r.amount)]));
  for (const id of channelIds) {
    result.set(id, byCh.has(id) ? byCh.get(id)! : null);
  }
  return result;
}

/**
 * チャネルごとの期間合計予算・遂行予算（ロケーションの sumLocationBudgetsForPeriodBatch と同型）
 */
export async function sumChannelBudgetsForPeriodBatch(
  shopId: string,
  channelIds: string[],
  dateFrom: string,
  dateTo: string,
  todayCutoff: string,
  yesterdayCutoff: string,
): Promise<Map<string, LocationPeriodBudgetFromDb>> {
  const result = new Map<string, LocationPeriodBudgetFromDb>();
  if (channelIds.length === 0) return result;

  const rows = await prisma.salesChannelBudget.findMany({
    where: {
      shopId,
      channelId: { in: channelIds },
      targetDate: { gte: dateFrom, lte: dateTo },
    },
    select: { channelId: true, targetDate: true, amount: true },
  });

  const byChannelDates = new Map<string, Map<string, number>>();
  for (const id of channelIds) {
    byChannelDates.set(id, new Map());
  }
  for (const r of rows) {
    const dm = byChannelDates.get(r.channelId);
    if (!dm) continue;
    if (!dm.has(r.targetDate)) {
      dm.set(r.targetDate, Number(r.amount));
    }
  }

  for (const id of channelIds) {
    const dm = byChannelDates.get(id)!;
    if (dm.size === 0) {
      result.set(id, { budgetTotal: null, progressBudgetToday: 0, progressBudgetPrev: 0 });
      continue;
    }
    let budgetTotal = 0;
    let progressBudgetToday = 0;
    let progressBudgetPrev = 0;
    for (const [targetDate, amt] of dm) {
      budgetTotal += amt;
      if (targetDate <= todayCutoff) progressBudgetToday += amt;
      if (targetDate <= yesterdayCutoff) progressBudgetPrev += amt;
    }
    result.set(id, { budgetTotal, progressBudgetToday, progressBudgetPrev });
  }

  return result;
}
