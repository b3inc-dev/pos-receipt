/**
 * Sales Summary Engine
 * 要件書 §21.6: 売上サマリー算出
 *
 * - Shopify注文データから日次KPIを算出（ショップタイムゾーンで「その日」の境界を算出）
 * - その日の返金を反映し actual を純売上（粗利−返金）とする（GAS_vs_APP_IMPLEMENTATION_GAP §7.3）
 * - 予算・入店数と組み合わせてキャッシュに保存
 */
import prisma from "../db.server";
import { getShopTimezoneForDaily, getDayRangeInUtc } from "../utils/shopTimezone.server";
import { expandLocationIdsForBudgetQuery } from "../utils/salesSummaryBudgetFromDb.server";
import {
  buildSettlementPreview,
  type SettlementPreviewDTO,
  type SettlementPreviewDebugDTO,
} from "./settlementEngine.server";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DailySummaryRowDTO {
  locationId: string;
  locationName: string;
  targetDate: string;
  actual: number;
  orders: number;
  items: number;
  visitors: number | null;
  budget: number | null;
  budgetRatio: number | null;
  conv: number | null;      // 購買率 = orders / visitors
  atv: number | null;       // 客単価 = actual / orders
  setRate: number | null;   // セット率 = items / orders
  unit: number | null;      // 一品単価 = actual / items
  currency: string;
  footfallReportingEnabled?: boolean;
  debug?: SettlementPreviewDebugDTO;
}

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

// ── メインエントリ ─────────────────────────────────────────────────────────────
/** 日次基礎数値は buildSettlementPreview のみ。旧 SUMMARY_ORDERS_QUERY / fetchSummaryOrders は削除済み。 */

/**
 * 精算プレビュー結果だけで日次キャッシュを更新（Shopify API は呼ばない）。
 * POS タイル起動時に month-rows と preview で二重集計しないための補助。
 */
export async function upsertDailySummaryCacheFromPreview(
  shopId: string,
  locationId: string,
  targetDate: string,
  preview: Pick<SettlementPreviewDTO, "netSales" | "orderCount" | "itemCount" | "currency">,
): Promise<void> {
  const locationGid = locationId.startsWith("gid://")
    ? locationId
    : `gid://shopify/Location/${locationId.replace("gid://shopify/Location/", "")}`;
  const idVariants = expandLocationIdsForBudgetQuery(locationGid);

  const actual = Number(preview.netSales);
  const orderCount = Number(preview.orderCount);
  const itemCount = Number(preview.itemCount);

  const [budget, footfall] = await Promise.all([
    prisma.budget.findFirst({
      where: { shopId, locationId: { in: idVariants }, targetDate },
    }),
    prisma.footfallReport.findFirst({
      where: { shopId, locationId: { in: idVariants }, targetDate },
    }),
  ]);

  const budgetAmount = budget ? Number(budget.amount) : null;
  const visitors = footfall?.visitors ?? null;
  const budgetRatio = budgetAmount && budgetAmount > 0 ? actual / budgetAmount : null;
  const conv = visitors && visitors > 0 ? orderCount / visitors : null;
  const atv = orderCount > 0 ? actual / orderCount : null;
  const setRate = orderCount > 0 ? itemCount / orderCount : null;
  const unit = itemCount > 0 ? actual / itemCount : null;

  await prisma.salesSummaryCacheDaily.upsert({
    where: {
      shopId_locationId_targetDate: { shopId, locationId: locationGid, targetDate },
    },
    update: {
      actual,
      orders: orderCount,
      items: itemCount,
      visitors,
      conv,
      atv,
      setRate,
      unit,
      budget: budgetAmount,
      budgetRatio,
    },
    create: {
      shopId,
      locationId: locationGid,
      targetDate,
      actual,
      orders: orderCount,
      items: itemCount,
      visitors,
      conv,
      atv,
      setRate,
      unit,
      budget: budgetAmount,
      budgetRatio,
    },
  });
}

export async function computeAndCacheDailySummary(
  admin: AdminClient,
  shopId: string,
  locationId: string,
  locationName: string,
  targetDate: string,
  opts?: { debug?: boolean },
): Promise<DailySummaryRowDTO> {
  const locIdRaw = locationId.replace("gid://shopify/Location/", "");
  if (!locIdRaw || !/^\d+$/.test(locIdRaw)) {
    throw new Error(`Invalid locationId: "${locationId}"`);
  }
  const locationGid = locationId.startsWith("gid://")
    ? locationId
    : `gid://shopify/Location/${locationId}`;

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dayRange = getDayRangeInUtc(targetDate, timezone);

  // 売上サマリーの基礎数値は精算プレビューと同じ集計関数を使用し、差分をゼロにする
  const preview = await buildSettlementPreview(
    admin,
    shopId,
    locationId,
    locationName,
    targetDate,
    { debug: opts?.debug === true },
  );
  const actual = Number(preview.netSales);
  const orderCount = Number(preview.orderCount);
  const itemCount = Number(preview.itemCount);
  const currency = preview.currency || "JPY";

  await upsertDailySummaryCacheFromPreview(shopId, locationId, targetDate, preview);

  const idVariants = expandLocationIdsForBudgetQuery(locationGid);
  const budget = await prisma.budget.findFirst({
    where: { shopId, locationId: { in: idVariants }, targetDate },
  });
  const footfall = await prisma.footfallReport.findFirst({
    where: { shopId, locationId: { in: idVariants }, targetDate },
  });
  const budgetAmount = budget ? Number(budget.amount) : null;
  const visitors = footfall?.visitors ?? null;
  const budgetRatio = budgetAmount && budgetAmount > 0 ? actual / budgetAmount : null;
  const conv = visitors && visitors > 0 ? orderCount / visitors : null;
  const atv = orderCount > 0 ? actual / orderCount : null;
  const setRate = orderCount > 0 ? itemCount / orderCount : null;
  const unit = itemCount > 0 ? actual / itemCount : null;

  return {
    locationId: locationGid,
    locationName,
    targetDate,
    actual,
    orders: orderCount,
    items: itemCount,
    visitors,
    budget: budgetAmount,
    budgetRatio,
    conv,
    atv,
    setRate,
    unit,
    currency,
    debug: preview.debug,
  };
}
