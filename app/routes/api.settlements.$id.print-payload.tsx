/**
 * GET /api/settlements/:id/print-payload
 * CloudPRNT 用: 指定精算の印字用テキストを返す。
 * プリンタのポーリングや再印字時に利用。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { buildSettlementReceiptText } from "../services/settlementEngine.server";
import type { SettlementPreviewDTO } from "../services/settlementEngine.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { shop, corsJson } = authResult;
    const id = params.id;
    if (!id) {
      return corsJson({ ok: false, error: "id is required" }, { status: 400 });
    }

    const settlement = await prisma.settlement.findFirst({
      where: { id, shopId: shop.id },
    });
    if (!settlement) {
      return corsJson({ ok: false, error: "Settlement not found" }, { status: 404 });
    }

    const location = await prisma.location.findFirst({
      where: { shopId: shop.id, shopifyLocationGid: settlement.locationId },
    });
    const locationName = location?.displayName ?? location?.name ?? settlement.locationId;

    const paymentSections = settlement.paymentSectionsJson
      ? (JSON.parse(settlement.paymentSectionsJson) as { label: string; net: number; refund: number }[])
      : [];

    const preview: SettlementPreviewDTO = {
      locationId: settlement.locationId,
      locationName,
      targetDate: settlement.targetDate,
      currency: settlement.currency ?? "JPY",
      total: Number(settlement.total),
      netSales: Number(settlement.netSales),
      tax: Number(settlement.tax),
      discounts: Number(settlement.discounts),
      vipPointsUsed: Number(settlement.vipPointsUsed),
      refundTotal: Number(settlement.refundTotal),
      orderCount: settlement.orderCount,
      refundCount: settlement.refundCount,
      itemCount: settlement.itemCount,
      voucherChangeAmount: Number(settlement.voucherChangeAmount),
      paymentSections,
      appliedSpecialRefundEvents: [],
      appliedVoucherAdjustments: [],
      loyaltyUsageDisplayLabel: "ポイント利用",
    };

    const printPayload = buildSettlementReceiptText(preview);

    return corsJson({ ok: true, printPayload });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
