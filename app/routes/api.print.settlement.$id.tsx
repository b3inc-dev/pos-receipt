/**
 * GET /api/print/settlement/:id
 * 精算／点検レシート HTML（Shopify Printing API の src）
 * 保存済み Settlement を使う。ライブ再集計しない。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsHtml,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import prisma from "../db.server";
import {
  renderPrintReceiptHtml,
  settlementPreviewToPrintModel,
} from "../services/printReceiptHtml";
import {
  getAppSetting,
  PRINT_SETTINGS_KEY,
  type PrintSettings,
} from "../utils/appSettings.server";
import {
  resolvePaperWidthMm,
  settlementRowToPreviewDTO,
} from "../services/printUnification.server";

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
    const preview = settlementRowToPreviewDTO(settlement, locationName);

    const printSettings =
      (await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {};
    const paper = resolvePaperWidthMm(printSettings);

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
