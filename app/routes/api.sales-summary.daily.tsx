/**
 * GET /api/sales-summary/daily
 * 要件書 §21.6: 日次売上サマリー
 * Query: targetDate, locationIds[]
 * 設定 §10: 売上サマリー設定で表示対象・KPI を制御
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson } from "../utils/posAuth.server";
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { getAppSetting } from "../utils/appSettings.server";
import { SALES_SUMMARY_SETTINGS_KEY, DEFAULT_SALES_SUMMARY_SETTINGS } from "../utils/appSettings.server";

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
    const url = new URL(request.url);
    const targetDate =
      url.searchParams.get("targetDate") ?? new Date().toISOString().slice(0, 10);
    const locationIdsParam = url.searchParams.getAll("locationIds[]");

    if (!merged.salesSummaryEnabled) {
      return corsJson({ rows: [], totals: { actual: 0, orders: 0, items: 0, budget: null, visitors: null }, displayOptions: merged, targetDate });
    }

    const allLocations = await prisma.location.findMany({
      where: { shopId: shop.id, salesSummaryEnabled: true },
    });

    let targetLocations =
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

    if (merged.visibleLocationIds.length > 0) {
      targetLocations = targetLocations.filter((l) =>
        merged.visibleLocationIds.includes(l.shopifyLocationGid)
      );
    }

    if (targetLocations.length === 0) {
      return corsJson({
        rows: [],
        totals: { actual: 0, orders: 0, items: 0, budget: null, visitors: null },
        displayOptions: merged,
        targetDate,
      });
    }

    // 各ロケーションを並列計算・キャッシュ
    const rows = await Promise.all(
      targetLocations.map(async (loc) => {
        const row = await computeAndCacheDailySummary(
          admin,
          shop.id,
          loc.shopifyLocationGid,
          loc.name,
          targetDate
        );
        return { ...row, footfallReportingEnabled: loc.footfallReportingEnabled };
      })
    );

    // 合計
    const totals = {
      actual: rows.reduce((s, r) => s + r.actual, 0),
      orders: rows.reduce((s, r) => s + r.orders, 0),
      items: rows.reduce((s, r) => s + r.items, 0),
      budget: rows.every((r) => r.budget !== null)
        ? rows.reduce((s, r) => s + (r.budget ?? 0), 0)
        : null,
      visitors: rows.some((r) => r.visitors !== null)
        ? rows.reduce((s, r) => s + (r.visitors ?? 0), 0)
        : null,
    };

    return corsJson({ rows, totals, targetDate, displayOptions: merged });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
