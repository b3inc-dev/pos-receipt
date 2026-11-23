/**
 * POST /api/special-refunds/:id/void
 * 要件書 21.4: 特殊返金イベント 無効化
 * 本文（任意・JSON）: { reason?: string, by?: string }
 * 無効にしたあと、注文メタフィールド pos.adjustments を書き直す（docs/ORDER_ADJUSTMENTS_METAFIELD.md）。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { voidAdjustmentEvent } from "../services/orderAdjustmentEdit.server";

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return corsErrorJson(request, { error: "Method not allowed" }, 405);
  }
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const eventId = params.id;
    if (!eventId) {
      return corsJson({ ok: false, error: "id required" }, { status: 400 });
    }
    const body = await readJsonBody(request);
    const result = await voidAdjustmentEvent(admin, shop.id, eventId, {
      reason: typeof body.reason === "string" ? body.reason : null,
      by: typeof body.by === "string" ? body.by : null,
    });
    if (!result.ok) {
      return corsJson({ ok: false, code: result.code, error: result.message }, { status: result.status });
    }
    return corsJson({
      ok: true,
      event: {
        id: result.eventId,
        status: "voided",
        shopifyRefundStatus: result.shopifyRefundStatus,
      },
      warning: result.warning,
      settlementAlreadyConfirmed: result.settlementAlreadyConfirmed,
      metafieldWritten: result.metafieldWritten,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
