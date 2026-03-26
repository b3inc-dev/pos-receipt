/**
 * POST /api/channel-budgets/upsert
 * Body: { channelId, targetDate, amount } — channelId はアプリ内 SalesChannel の id（cuid）
 */
import type { ActionFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import prisma from "../db.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";

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

    const access = checkPlanAccess(shop.planCode, "budget_management", fullAccess);
    if (!access.allowed) {
      return corsJson({ ok: false, error: access.message }, { status: 403 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const { channelId, targetDate, amount } = body;

    if (!channelId || !targetDate || amount === undefined) {
      return corsJson(
        { ok: false, error: "channelId, targetDate, amount are required" },
        { status: 400 },
      );
    }

    const channelIdStr = String(channelId);
    const targetDateStr = String(targetDate);
    const amountNum = Number(amount);

    const ch = await prisma.salesChannel.findFirst({
      where: { id: channelIdStr, shopId: shop.id },
    });
    if (!ch) {
      return corsJson({ ok: false, error: "channel not found" }, { status: 404 });
    }

    const saved = await prisma.salesChannelBudget.upsert({
      where: {
        shopId_channelId_targetDate: {
          shopId: shop.id,
          channelId: channelIdStr,
          targetDate: targetDateStr,
        },
      },
      update: { amount: amountNum },
      create: {
        shopId: shop.id,
        channelId: channelIdStr,
        targetDate: targetDateStr,
        amount: amountNum,
      },
    });

    const cached = await prisma.salesChannelCacheDaily.findUnique({
      where: {
        shopId_channelId_targetDate: {
          shopId: shop.id,
          channelId: channelIdStr,
          targetDate: targetDateStr,
        },
      },
    });
    if (cached) {
      const actual = Number(cached.actual);
      const budgetRatio = amountNum > 0 ? actual / amountNum : null;
      await prisma.salesChannelCacheDaily.update({
        where: {
          shopId_channelId_targetDate: {
            shopId: shop.id,
            channelId: channelIdStr,
            targetDate: targetDateStr,
          },
        },
        data: { budget: amountNum, budgetRatio },
      });
    }

    return corsJson({ ok: true, budget: { ...saved, amount: saved.amount.toString() } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
