/**
 * GET /api/print/settlement/:id
 * 精算／点検レシート HTML（Shopify Printing API の src）
 * 旧 order_based / cloudprnt 経路は残置。本ルートは並存の新経路。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsHtml,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import prisma from "../db.server";
import type { SettlementPreviewDTO } from "../services/settlementEngine.server";
import {
  renderPrintReceiptHtml,
  settlementPreviewToPrintModel,
} from "../services/printReceiptHtml";
import {
  getAppSetting,
  PRINT_SETTINGS_KEY,
  DEFAULT_PRINT_SETTINGS,
  type PrintSettings,
} from "../utils/appSettings.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { shop } = authResult;
    const id = params.id;
    if (!id) {
      return corsErrorJson(request, { ok: false, error: "id is required" }, 400);
    }

    const settlement = await prisma.settlement.findFirst({
      where: { id, shopId: shop.id },
    });
    if (!settlement) {
      return corsHtml(
        request,
        `<!DOCTYPE html><html><body><p>精算が見つかりません。</p></body></html>`,
        { status: 404 },
      );
    }

    const location = await prisma.location.findFirst({
      where: { shopId: shop.id, shopifyLocationGid: settlement.locationId },
    });
    const locationName = location?.displayName ?? location?.name ?? settlement.locationId;

    const rawSections = settlement.paymentSectionsJson
      ? (JSON.parse(settlement.paymentSectionsJson) as Record<string, unknown>[])
      : [];
    const paymentSections = rawSections.map((s) => ({
      gateway: String(s.gateway ?? s.label ?? ""),
      label: String(s.label ?? s.gateway ?? ""),
      net: Number(s.net ?? 0),
      refund: Number(s.refund ?? 0),
      txCount: Number(s.txCount ?? 0),
      refundCount: Number(s.refundCount ?? 0),
    }));

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
      settlementTxFirstHm: null,
      settlementTxLastHm: null,
      taxShopify: 0,
    };

    const printSettings =
      (await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {};
    const paper =
      (printSettings.cloudprntPaperWidth ?? DEFAULT_PRINT_SETTINGS.cloudprntPaperWidth) === "58mm"
        ? 58
        : 80;

    const isInspection = String(settlement.periodLabel ?? "").startsWith("点検");
    const html = renderPrintReceiptHtml(
      settlementPreviewToPrintModel(preview, {
        isInspection,
        paperWidthMm: paper,
      }),
    );
    return corsHtml(request, html);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
