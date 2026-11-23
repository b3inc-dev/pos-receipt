/**
 * POST /api/refund-reservations/:id/cancel — 返金の予約を取り消す（使う前の予約・要確認の予約だけ）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { cancelRefundReservation, serializeReservation } from "../services/refundReservation.server";

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") return corsErrorJson(request, { error: "Method not allowed" }, 405);
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { shop, corsJson } = authResult;
    const id = String(params.id ?? "");
    if (!id) return corsJson({ ok: false, error: "id is required" }, { status: 400 });
    const r = await cancelRefundReservation(shop.id, id);
    if (!r.ok) return corsJson({ ok: false, error: r.message }, { status: r.status });
    return corsJson({ ok: true, reservation: serializeReservation(r.reservation) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
