/**
 * POST /api/budgets/upsert
 * 要件書 §21.6: 予算登録・更新
 * Body: { locationId, targetDate, amount }
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { checkPlanAccess } from "../utils/planFeatures.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

    const access = checkPlanAccess(shop.planCode, "budget_management");
    if (!access.allowed) {
      return Response.json({ ok: false, error: access.message }, { status: 403 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const { locationId, targetDate, amount } = body;

    if (!locationId || !targetDate || amount === undefined) {
      return Response.json(
        { ok: false, error: "locationId, targetDate, amount are required" },
        { status: 400 }
      );
    }

    const locationGid = String(locationId).startsWith("gid://")
      ? String(locationId)
      : `gid://shopify/Location/${locationId}`;
    const targetDateStr = String(targetDate);
    const amountNum = Number(amount);

    const saved = await prisma.budget.upsert({
      where: {
        shopId_locationId_targetDate: {
          shopId: shop.id,
          locationId: locationGid,
          targetDate: targetDateStr,
        },
      },
      update: { amount: amountNum },
      create: {
        shopId: shop.id,
        locationId: locationGid,
        targetDate: targetDateStr,
        amount: amountNum,
      },
    });

    // 日次キャッシュの budgetRatio を即時更新
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
      const actual = Number(cached.actual);
      const budgetRatio = amountNum > 0 ? actual / amountNum : null;
      await prisma.salesSummaryCacheDaily.update({
        where: {
          shopId_locationId_targetDate: {
            shopId: shop.id,
            locationId: locationGid,
            targetDate: targetDateStr,
          },
        },
        data: { budget: amountNum, budgetRatio },
      });
    }

    return Response.json({ ok: true, budget: { ...saved, amount: saved.amount.toString() } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
