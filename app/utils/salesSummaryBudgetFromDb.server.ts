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
 * 合計行用: 各行の予算フィールド（budget / budgetTotal など）を足す。
 * null・undefined の行はスキップ。1件でも数値があれば合計を返し、すべて未設定なら null（「-」表示）。
 * 従来の「全行そろわないと null」だと、1店だけ予算未登録で POS合計・総合計の予算が常に「-」になっていた。
 */
export function sumOptionalBudgetColumn(rows: ReadonlyArray<object>, key: string): number | null {
  let sum = 0;
  let anyPresent = false;
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[key];
    if (v != null) {
      anyPresent = true;
      sum += Number(v);
    }
  }
  return anyPresent ? sum : null;
}
