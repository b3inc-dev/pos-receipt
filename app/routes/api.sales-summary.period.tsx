/**
 * GET /api/sales-summary/period
 * 要件書 §21.6: 期間売上サマリー
 * Query: dateFrom, dateTo, budgetDateTo?（月予算だけ dateFrom〜budgetDateTo で集計）,
 * progressAsOfDate?（遂行予算の締め日。未指定時は店舗タイムゾーンの当日）, locationIds[]
 * 設定 §10: 売上サマリー設定で表示対象を制御
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { buildPeriodSalesSummaryPayload } from "../services/salesSummaryPeriodPayload.server";

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

    const url = new URL(request.url);
    const payload = await buildPeriodSalesSummaryPayload(admin, shop, {
      dateFrom: url.searchParams.get("dateFrom"),
      dateTo: url.searchParams.get("dateTo"),
      budgetDateTo: url.searchParams.get("budgetDateTo"),
      progressAsOfDate: url.searchParams.get("progressAsOfDate"),
      locationIdsParam: url.searchParams.getAll("locationIds[]"),
    });

    return corsJson(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
