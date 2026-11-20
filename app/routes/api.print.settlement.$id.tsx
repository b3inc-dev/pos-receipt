/**
 * GET /api/print/settlement/:id
 * 精算／点検レシート HTML（Shopify Printing API の src）
 * 保存済み表示内容（金額・店舗表示名・帳票版）を使う。ライブ再集計しない。
 * 用紙幅は出力機器設定（再印刷時点）を適用する。
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
  getAppSetting,
  PRINT_SETTINGS_KEY,
  type PrintSettings,
} from "../utils/appSettings.server";
import { resolvePaperWidthMm } from "../services/printUnification.server";
import { buildSettlementReprintView } from "../services/settlementPrintSnapshot.server";

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
    const currentLocationName =
      location?.displayName ?? location?.name ?? settlement.locationId;

    const printSettings =
      (await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {};
    const devicePaperWidthMm = resolvePaperWidthMm(printSettings);

    const reprint = buildSettlementReprintView(settlement, {
      currentLocationName,
      devicePaperWidthMm,
    });
    return corsHtml(request, reprint.html);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
