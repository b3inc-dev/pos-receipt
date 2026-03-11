/**
 * GET /api/sales-summary/period
 * 要件書 §21.6: 期間売上サマリー
 * Query: dateFrom, dateTo, locationIds[]
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticatePosRequest } from "../utils/posAuth.server";
import prisma from "../db.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, shop, corsJson } = await authenticatePosRequest(request);
    const fullAccess = await getFullAccess(admin, { shop: shop.shopDomain });

    const access = checkPlanAccess(shop.planCode, "sales_summary", fullAccess);
    if (!access.allowed) {
      return corsJson({ ok: false, error: access.message }, { status: 403 });
    }

    const url = new URL(request.url);
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const locationIdsParam = url.searchParams.getAll("locationIds[]");

    const allLocations = await prisma.location.findMany({
      where: { shopId: shop.id, salesSummaryEnabled: true },
    });

    const targetLocations =
      locationIdsParam.length > 0
        ? allLocations.filter((l) =>
            locationIdsParam.some(
              (id) =>
                l.shopifyLocationGid === id ||
                l.shopifyLocationGid.endsWith(`/${id}`) ||
                id.endsWith(l.shopifyLocationGid.replace("gid://shopify/Location/", ""))
            )
          )
        : allLocations;

    const locationGids = targetLocations.map((l) => l.shopifyLocationGid);

    if (locationGids.length === 0) {
      return corsJson({ rows: [], totals: {}, dateFrom, dateTo });
    }

    // 日次キャッシュから集計
    const whereTargetDate: Record<string, string> = {};
    if (dateFrom) whereTargetDate.gte = dateFrom;
    if (dateTo) whereTargetDate.lte = dateTo;

    const dailyRows = await prisma.salesSummaryCacheDaily.findMany({
      where: {
        shopId: shop.id,
        locationId: { in: locationGids },
        ...(Object.keys(whereTargetDate).length > 0 ? { targetDate: whereTargetDate } : {}),
      },
    });

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const locNameMap = new Map(targetLocations.map((l) => [l.shopifyLocationGid, l.name]));

    // ロケーション別集計
    const locationMap = new Map<
      string,
      {
        locationId: string;
        locationName: string;
        actualTotal: number;
        budgetTotal: number | null;
        orders: number;
        items: number;
        progressBudgetToday: number;
        progressBudgetPrev: number;
      }
    >();

    for (const row of dailyRows) {
      if (!locationMap.has(row.locationId)) {
        locationMap.set(row.locationId, {
          locationId: row.locationId,
          locationName: locNameMap.get(row.locationId) ?? row.locationId,
          actualTotal: 0,
          budgetTotal: null,
          orders: 0,
          items: 0,
          progressBudgetToday: 0,
          progressBudgetPrev: 0,
        });
      }
      const entry = locationMap.get(row.locationId)!;
      entry.actualTotal += Number(row.actual);
      entry.orders += row.orders;
      entry.items += row.items;
      if (row.budget !== null) {
        entry.budgetTotal = (entry.budgetTotal ?? 0) + Number(row.budget);
        if (row.targetDate <= today) entry.progressBudgetToday += Number(row.budget);
        if (row.targetDate <= yesterday) entry.progressBudgetPrev += Number(row.budget);
      }
    }

    const rows = Array.from(locationMap.values()).map((entry) => ({
      ...entry,
      achievementRate:
        entry.budgetTotal && entry.budgetTotal > 0
          ? entry.actualTotal / entry.budgetTotal
          : null,
      progressRateToday:
        entry.progressBudgetToday > 0
          ? entry.actualTotal / entry.progressBudgetToday
          : null,
      progressRatePrev:
        entry.progressBudgetPrev > 0
          ? entry.actualTotal / entry.progressBudgetPrev
          : null,
    }));

    const totals = {
      actualTotal: rows.reduce((s, r) => s + r.actualTotal, 0),
      budgetTotal: rows.every((r) => r.budgetTotal !== null)
        ? rows.reduce((s, r) => s + (r.budgetTotal ?? 0), 0)
        : null,
      orders: rows.reduce((s, r) => s + r.orders, 0),
      items: rows.reduce((s, r) => s + r.items, 0),
    };

    return corsJson({ rows, totals, dateFrom, dateTo });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsJson({ ok: false, error: message }, { status: 500 });
  }
}
