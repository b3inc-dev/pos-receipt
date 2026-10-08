/**
 * GET /api/settings/print — POS 向け印字設定（Printing API フラグ）
 * Admin の preferPrintingApi 等と POS 案内の primary/secondary を一致させる。
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
  DEFAULT_PRINT_SETTINGS,
  type PrintSettings,
} from "../utils/appSettings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { shop, corsJson } = authResult;

    const saved =
      (await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {};
    const settings: PrintSettings = { ...DEFAULT_PRINT_SETTINGS, ...saved };

    return corsJson({
      ok: true,
      preferPrintingApi: !!settings.preferPrintingApi,
      settlementPrintingApiEnabled: !!settings.settlementPrintingApiEnabled,
      receiptPrintingApiEnabled: !!settings.receiptPrintingApiEnabled,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

/** OPTIONS プリフライト対応（GET でも Authorization 付きだとブラウザが OPTIONS を送るため） */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
