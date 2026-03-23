/**
 * GET /api/sales-summary/period
 * 要件書 §21.6: 期間売上サマリー
 * Query: dateFrom, dateTo, locationIds[]
 * 設定 §10: 売上サマリー設定で表示対象を制御
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { getAppSetting } from "../utils/appSettings.server";
import { SALES_SUMMARY_SETTINGS_KEY, DEFAULT_SALES_SUMMARY_SETTINGS } from "../utils/appSettings.server";

type SalesSummaryLocationRow = Awaited<ReturnType<typeof prisma.location.findMany>>[number];

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    const fullAccess = await getFullAccess(admin, { shop: shop.shopDomain });

    const access = checkPlanAccess(shop.planCode, "sales_summary", fullAccess);
    if (!access.allowed) {
      return corsJson({ ok: false, error: access.message }, { status: 403 });
    }

    const settings = await getAppSetting<typeof DEFAULT_SALES_SUMMARY_SETTINGS>(shop.id, SALES_SUMMARY_SETTINGS_KEY);
    const merged = { ...DEFAULT_SALES_SUMMARY_SETTINGS, ...settings };
    if (!merged.salesSummaryEnabled) {
      return corsJson({ rows: [], totals: {}, dateFrom: null, dateTo: null, displayOptions: merged });
    }

    const url = new URL(request.url);
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const locationIdsParam = url.searchParams.getAll("locationIds[]");

    let allLocations: SalesSummaryLocationRow[] = await prisma.location.findMany({
      where: { shopId: shop.id, salesSummaryEnabled: true },
    });

    // フォールバック: DB に salesSummaryEnabled な Location が未設定の場合は
    // Shopify のアクティブなロケーションを自動同期して有効化する
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
            if (!lNum) return false; // 空 GID は除外
            return locationIdsParam.some((id) => {
              const idNum = id.replace("gid://shopify/Location/", "");
              return lNum === idNum;
            });
          })
        : allLocations;

    // locationIds 指定時は厳密一致のみ対象にする（不一致時に全店舗へフォールバックしない）

    if (merged.visibleLocationIds.length > 0) {
      const filtered = targetLocations.filter((l: SalesSummaryLocationRow) =>
        merged.visibleLocationIds.includes(l.shopifyLocationGid)
      );
      targetLocations = filtered;
    }

    const locationGids = targetLocations.map((l) => l.shopifyLocationGid);

    if (locationGids.length === 0) {
      return corsJson({ rows: [], totals: {}, dateFrom, dateTo, displayOptions: merged });
    }

    // 期間表示時は先に日次キャッシュを再計算する（ロケーション除外ロジック変更後も正しい数字が出るように）
    const MAX_DAYS_TO_REFRESH = 31;
    if (dateFrom && dateTo) {
      const start = new Date(dateFrom + "T00:00:00Z").getTime();
      const end = new Date(dateTo + "T23:59:59Z").getTime();
      const days: string[] = [];
      for (let t = start; t <= end && days.length < MAX_DAYS_TO_REFRESH; t += 86400000) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      await Promise.all(
        targetLocations.flatMap((loc) =>
          days.map((targetDate) =>
            computeAndCacheDailySummary(admin, shop.id, loc.shopifyLocationGid, loc.name, targetDate)
          )
        )
      );
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

    return corsJson({ rows, totals, dateFrom, dateTo, displayOptions: merged });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
