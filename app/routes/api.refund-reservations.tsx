/**
 * GET  /api/refund-reservations?sourceOrderId=...  → その注文の返金の予約（開いたときに、できた返金へ当て直す）
 * POST /api/refund-reservations                     → 予約する。本文: { sourceOrderId, sourceOrderName?, locationId?,
 *        rows: [{ actualRefundMethod, eventType, amount }]（最後の行は残り）, note?, createdBy? }
 * docs/REFUND_RESERVATION.md。Shopify では返金しない。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { loadRefundMethodResolver } from "../utils/paymentMethod.server";
import {
  applyRefundReservationsForOrder,
  createRefundReservation,
  listRefundReservations,
  serializeReservation,
} from "../services/refundReservation.server";

async function withLabels(shopId: string, items: Awaited<ReturnType<typeof listRefundReservations>>) {
  const resolver = await loadRefundMethodResolver(shopId);
  return items.map((r) => {
    const s = serializeReservation(r);
    return {
      ...s,
      rows: s.rows.map((row) => ({ ...row, actualRefundLabel: resolver.labelForMethod(row.actualRefundMethod) })),
    };
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    const sourceOrderId = new URL(request.url).searchParams.get("sourceOrderId");
    if (!sourceOrderId) return corsJson({ ok: false, error: "sourceOrderId is required" }, { status: 400 });
    let applyError: string | null = null;
    try {
      await applyRefundReservationsForOrder(admin, shop.id, sourceOrderId);
    } catch (e) {
      console.warn("[refund-reservations] apply failed", e);
      applyError = "Shopify の注文の返金を読めませんでした。少し待って、もう一度開いてください。";
    }
    const items = await listRefundReservations(shop.id, sourceOrderId);
    return corsJson({ ok: true, items: await withLabels(shop.id, items), applyError });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") return corsErrorJson(request, { error: "Method not allowed" }, 405);
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (!body.sourceOrderId) return corsJson({ ok: false, error: "sourceOrderId is required" }, { status: 400 });
    const r = await createRefundReservation(admin, shop.id, {
      sourceOrderId: String(body.sourceOrderId),
      sourceOrderName: body.sourceOrderName != null ? String(body.sourceOrderName) : null,
      locationId: body.locationId != null ? String(body.locationId) : null,
      rows: body.rows,
      note: body.note != null ? String(body.note) : null,
      createdBy: body.createdBy != null ? String(body.createdBy) : null,
    });
    if (!r.ok) return corsJson({ ok: false, code: r.code, error: r.message }, { status: r.status });
    const [item] = await withLabels(shop.id, [r.reservation]);
    return corsJson({ ok: true, reservation: item }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
