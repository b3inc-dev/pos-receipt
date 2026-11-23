/**
 * POST /api/footfall
 * 要件書 §21.6: 入店数報告
 * Body: { locationId, targetDate, visitors, createdBy? }
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { writeFootfallVisitors } from "../services/footfallWrite.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import {
  getAppSetting,
  SALES_SUMMARY_SETTINGS_KEY,
  mergeAndNormalizeSalesSummarySettings,
  isFootfallReportingAllowedForLocation,
  type SalesSummarySettings,
} from "../utils/appSettings.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return corsErrorJson(request, { error: "Method not allowed" }, 405);
  }
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    const fullAccess = await getFullAccess(admin, { shop: shop.shopDomain });

    const access = checkPlanAccess(shop.planCode, "footfall_reporting", fullAccess);
    if (!access.allowed) {
      return corsJson({ ok: false, error: access.message }, { status: 403 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const { locationId, targetDate, visitors, createdBy } = body;

    if (!locationId || !targetDate || visitors === undefined) {
      return corsJson(
        { ok: false, error: "locationId, targetDate, visitors are required" },
        { status: 400 }
      );
    }

    const locationGid = String(locationId).startsWith("gid://")
      ? String(locationId)
      : `gid://shopify/Location/${locationId}`;

    const settings = await getAppSetting<Partial<SalesSummarySettings>>(shop.id, SALES_SUMMARY_SETTINGS_KEY);
    const merged = mergeAndNormalizeSalesSummarySettings(settings ?? undefined);
    if (!isFootfallReportingAllowedForLocation(merged, locationGid)) {
      return corsJson(
        {
          ok: false,
          error:
            "入店数報告は売上サマリー設定でオフになっているか、このロケーションが対象に含まれていません。",
        },
        { status: 403 }
      );
    }

    // ショップに属するロケーションか確認（DB 未登録時は Shopify 一覧で照合）
    const dbLoc = await prisma.location.findFirst({
      where: { shopId: shop.id, shopifyLocationGid: locationGid },
    });
    if (!dbLoc) {
      const locRes = await admin.graphql(`#graphql
        query { locations(first: 50, includeLegacy: false) { nodes { id } } }
      `);
      const locJson = (await locRes.json()) as {
        data?: { locations?: { nodes?: { id: string }[] } };
      };
      const ids = locJson.data?.locations?.nodes?.map((n) => n.id) ?? [];
      if (!ids.includes(locationGid)) {
        return corsJson({ ok: false, error: "このショップのロケーションではありません" }, { status: 403 });
      }
    }

    const targetDateStr = String(targetDate);
    const visitorsNum = Number(visitors);

    if (!Number.isInteger(visitorsNum) || visitorsNum < 0) {
      return corsJson({ ok: false, error: "入店数は 0 以上の整数で入れてください" }, { status: 400 });
    }

    await writeFootfallVisitors(prisma, {
      shopId: shop.id,
      locationGid,
      date: targetDateStr,
      visitors: visitorsNum,
      source: "pos",
      enteredAt: new Date(),
      createdBy: createdBy ? String(createdBy) : null,
    });
    const saved = await prisma.footfallReport.findUnique({
      where: { shopId_locationId_targetDate: { shopId: shop.id, locationId: locationGid, targetDate: targetDateStr } },
    });

    // Ciara のカスタムアプリで ciara-system とそろえているときは、この 1 日ぶんをすぐ送る（待たせない。失敗しても 10 分ごとの回で送る）
    void import("../services/ciaraVisitSync.server")
      .then((m) => m.pushFootfallToCiara(shop.id, locationGid, targetDateStr))
      .catch((e) => console.warn("[footfall] ciara push failed", e));

    return corsJson({ ok: true, saved: { ...saved } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
