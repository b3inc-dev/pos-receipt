/**
 * GET /api/sales-summary/daily
 * 要件書 §21.6: 日次売上サマリー
 * Query: targetDate, locationIds[]
 * 設定 §10: 売上サマリー設定で表示対象・KPI を制御
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { buildDailySalesSummaryPayload } from "../services/salesSummaryDailyPayload.server";

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
    const payload = await buildDailySalesSummaryPayload(admin, shop, {
      targetDate: url.searchParams.get("targetDate"),
      locationIdsParam: url.searchParams.getAll("locationIds[]"),
      forceRecompute: url.searchParams.get("recompute") === "1",
    });

    return corsJson({
      ...payload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
