/**
 * POST /api/special-refunds/:id/edit
 * 返金方法変更・商品券釣銭登録の「変更」: 前の行を無効にし、replaces 付きの新しい行を足す（Shopify の返金はしない）。
 * 本文（JSON）: {
 *   reason: string（必須・直したわけ）, by?: string,
 *   dateMode?: "original"（初めの値・元の日のまま）| "today",
 *   amount?, originalPaymentMethod?, actualRefundMethod?, adjustKind?, note?,
 *   voucherFaceValue?, voucherAppliedAmount?（商品券。お釣りは額面 − 使った額）
 * }
 * 書いたあと、注文メタフィールド pos.adjustments を書き直す（docs/ORDER_ADJUSTMENTS_METAFIELD.md）。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { editAdjustmentEvent } from "../services/orderAdjustmentEdit.server";
import { parseAdjustmentEditBody } from "../utils/orderAdjustmentEditInput";

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
    if (!eventId) return corsJson({ ok: false, error: "id required" }, { status: 400 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return corsJson({ ok: false, error: "JSON body required" }, { status: 400 });
    }
    const result = await editAdjustmentEvent(admin, shop.id, eventId, parseAdjustmentEditBody(body));
    if (!result.ok) {
      return corsJson({ ok: false, code: result.code, error: result.message }, { status: result.status });
    }
    return corsJson({
      ok: true,
      voidedEventId: result.eventId,
      newEventId: result.newEventId,
      warning: result.warning,
      settlementAlreadyConfirmed: result.settlementAlreadyConfirmed,
      confirmedDates: result.confirmedDates,
      metafieldWritten: result.metafieldWritten,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
