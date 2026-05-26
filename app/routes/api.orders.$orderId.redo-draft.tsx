/**
 * POST /api/orders/:orderId/redo-draft
 * キャンセル・返金済み注文から会計やり直し用の下書き注文を作成
 */
import type { ActionFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import {
  getAppSetting,
  SPECIAL_REFUND_SETTINGS_KEY,
  DEFAULT_SPECIAL_REFUND_SETTINGS,
  type SpecialRefundSettings,
} from "../utils/appSettings.server";
import { createRedoDraftFromOrder } from "../services/orderRedoDraft.server";

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return corsErrorJson(request, { error: "Method not allowed" }, 405);
  }

  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const orderId = params.orderId;
    if (!orderId) {
      return corsJson({ ok: false, error: "orderId required" }, { status: 400 });
    }

    const settingsRaw = await getAppSetting<Partial<SpecialRefundSettings>>(
      shop.id,
      SPECIAL_REFUND_SETTINGS_KEY,
    );
    const settings = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...settingsRaw };
    if (!settings.enableOrderRedoDraft) {
      return corsJson(
        { ok: false, error: "会計やり直し（下書き作成）は設定で無効になっています" },
        { status: 403 },
      );
    }

    const result = await createRedoDraftFromOrder(admin, orderId);
    if (!result.ok) {
      return corsJson({ ok: false, error: result.error }, { status: 400 });
    }

    return corsJson(
      {
        ok: true,
        draftOrder: result.draftOrder,
        sourceOrder: result.sourceOrder,
        skippedLineCount: result.skippedLineCount,
        message:
          "下書き注文を作成しました。Shopify POS または管理画面の「下書き注文」から会計・決済を完了してください。",
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
