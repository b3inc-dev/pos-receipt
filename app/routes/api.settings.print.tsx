/**
 * GET /api/settings/print — POS 向け印字設定
 * 保存済みの旧フラグは読み取るが、出力経路は常に shopify.printing。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import {
  getAppSetting,
  PRINT_SETTINGS_KEY,
  SETTLEMENT_SETTINGS_KEY,
  DEFAULT_PRINT_SETTINGS,
  DEFAULT_SETTLEMENT_SETTINGS,
  type PrintSettings,
  type SettlementSettings,
} from "../utils/appSettings.server";
import { UNIFIED_PRINT_MODE, resolvePaperWidthMm } from "../services/printUnification.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { shop, corsJson } = authResult;

    const saved =
      (await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {};
    const settlementSaved =
      (await getAppSetting<Partial<SettlementSettings>>(shop.id, SETTLEMENT_SETTINGS_KEY)) ?? {};
    const settings: PrintSettings = { ...DEFAULT_PRINT_SETTINGS, ...saved };
    const settlement: SettlementSettings = { ...DEFAULT_SETTLEMENT_SETTINGS, ...settlementSaved };

    return corsJson({
      ok: true,
      printMode: UNIFIED_PRINT_MODE,
      preferPrintingApi: true,
      settlementPrintingApiEnabled: true,
      receiptPrintingApiEnabled: true,
      allowReprintSettlement: settlement.allowReprintSettlement !== false,
      paperWidthMm: resolvePaperWidthMm(settings),
      storedLegacyPrintMode: saved.defaultPrintMode ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
