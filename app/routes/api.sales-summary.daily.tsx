/**
 * GET /api/sales-summary/daily
 * 要件書 §21.6: 日次売上サマリー
 * Query: targetDate, locationIds[]
 * 設定 §10: 売上サマリー設定で表示対象・KPI を制御
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { parseSalesSummaryLoadId } from "../utils/salesSummaryLoadShare.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { buildDailySalesSummaryPayload } from "../services/salesSummaryDailyPayload.server";
import { kickCiaraVisitSyncOnOpen } from "../services/ciaraVisitSync.server";

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

    // Ciara のカスタムアプリで ciara-system と入店数を見せ合うときは、開いたときにも読む（待たせない・1 分に 1 回まで）
    kickCiaraVisitSyncOnOpen(shop.id, admin);

    const url = new URL(request.url);
    const locationIdsParam = url.searchParams.getAll("locationIds[]");
    const payload = await buildDailySalesSummaryPayload(admin, shop, {
      targetDate: url.searchParams.get("targetDate"),
      locationIdsParam,
      forceRecompute: url.searchParams.get("recompute") === "1",
      loadId: parseSalesSummaryLoadId(url.searchParams.get("loadId")),
      // 個店表示（店を指定）では POS がチャネル行も合計も出さないので数えない
      skipChannels: locationIdsParam.length > 0,
      // 保存済みの数字だけを返す（全店表示で「○時○分時点」を先に出す用。数え直さない）
      cachedOnly: url.searchParams.get("cachedOnly") === "1",
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
