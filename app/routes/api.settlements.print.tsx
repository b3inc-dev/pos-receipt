/**
 * GET  /api/settlements/print  → 精算履歴一覧
 * POST /api/settlements/print  → 印字済みマーク
 * 要件書 §21.3, §6.10
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const url = new URL(request.url);
    const locationId = url.searchParams.get("locationId");
    const targetDate = url.searchParams.get("targetDate");
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20);

    const where: Parameters<typeof prisma.settlement.findMany>[0]["where"] = {
      shopId: shop.id,
    };
    if (locationId) (where as Record<string, unknown>).locationId = locationId;
    if (targetDate) (where as Record<string, unknown>).targetDate = targetDate;

    const settlements = await prisma.settlement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return corsJson({
      items: settlements.map(serializeSettlement),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    if (request.method !== "POST") {
      return corsJson({ error: "Method not allowed" }, { status: 405 });
    }

    const body = await request.json() as { settlementId?: string };
    const { settlementId } = body;

    if (!settlementId) {
      return corsJson({ ok: false, error: "settlementId is required" }, { status: 400 });
    }

    const existing = await prisma.settlement.findFirst({
      where: { id: settlementId, shopId: shop.id },
    });
    if (!existing) {
      return corsJson({ ok: false, error: "Settlement not found" }, { status: 404 });
    }

    const updated = await prisma.settlement.update({
      where: { id: settlementId },
      data: { status: "printed", printedAt: new Date() },
    });

    return corsJson({ ok: true, settlement: serializeSettlement(updated) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

type SettlementRecord = Awaited<ReturnType<typeof prisma.settlement.findFirst>>;

function serializeSettlement(s: NonNullable<SettlementRecord>) {
  return {
    id: s.id,
    locationId: s.locationId,
    targetDate: s.targetDate,
    periodLabel: s.periodLabel,
    currency: s.currency,
    total: s.total.toString(),
    netSales: s.netSales.toString(),
    tax: s.tax.toString(),
    discounts: s.discounts.toString(),
    vipPointsUsed: s.vipPointsUsed.toString(),
    refundTotal: s.refundTotal.toString(),
    orderCount: s.orderCount,
    refundCount: s.refundCount,
    itemCount: s.itemCount,
    voucherChangeAmount: s.voucherChangeAmount.toString(),
    paymentSections: s.paymentSectionsJson ? JSON.parse(s.paymentSectionsJson) : [],
    printMode: s.printMode,
    status: s.status,
    printedAt: s.printedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    sourceOrderId: s.sourceOrderId,
    sourceOrderName: s.sourceOrderName,
  };
}
