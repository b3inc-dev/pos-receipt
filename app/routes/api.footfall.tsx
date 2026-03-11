/**
 * POST /api/footfall
 * 要件書 §21.6: 入店数報告
 * Body: { locationId, targetDate, visitors, createdBy? }
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequest } from "../utils/posAuth.server";
import prisma from "../db.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return corsJson({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, shop, corsJson } = await authenticatePosRequest(request);
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

    // footfall_reporting_enabled チェック
    const loc = await prisma.location.findFirst({
      where: { shopId: shop.id, shopifyLocationGid: locationGid },
    });
    if (!loc?.footfallReportingEnabled) {
      return corsJson(
        { ok: false, error: "Footfall reporting is not enabled for this location" },
        { status: 403 }
      );
    }

    const targetDateStr = String(targetDate);
    const visitorsNum = Number(visitors);

    const saved = await prisma.footfallReport.upsert({
      where: {
        shopId_locationId_targetDate: {
          shopId: shop.id,
          locationId: locationGid,
          targetDate: targetDateStr,
        },
      },
      update: { visitors: visitorsNum, createdBy: createdBy ? String(createdBy) : null },
      create: {
        shopId: shop.id,
        locationId: locationGid,
        targetDate: targetDateStr,
        visitors: visitorsNum,
        createdBy: createdBy ? String(createdBy) : null,
      },
    });

    // 日次キャッシュの conv を即時更新
    const cached = await prisma.salesSummaryCacheDaily.findUnique({
      where: {
        shopId_locationId_targetDate: {
          shopId: shop.id,
          locationId: locationGid,
          targetDate: targetDateStr,
        },
      },
    });
    if (cached) {
      const conv = visitorsNum > 0 ? cached.orders / visitorsNum : null;
      await prisma.salesSummaryCacheDaily.update({
        where: {
          shopId_locationId_targetDate: {
            shopId: shop.id,
            locationId: locationGid,
            targetDate: targetDateStr,
          },
        },
        data: { visitors: visitorsNum, conv },
      });
    }

    return corsJson({ ok: true, saved: { ...saved } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsJson({ ok: false, error: message }, { status: 500 });
  }
}
