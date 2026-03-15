/**
 * POST /api/special-refunds/:id/void
 * 要件書 21.4: 特殊返金イベント 無効化
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";

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

    const existing = await prisma.specialRefundEvent.findFirst({
      where: { id: eventId, shopId: shop.id },
    });
    if (!existing) {
      return corsJson({ ok: false, error: "Event not found" }, { status: 404 });
    }
    if (existing.status === "voided") {
      return corsJson({ ok: false, error: "Already voided" }, { status: 409 });
    }

    const updated = await prisma.specialRefundEvent.update({
      where: { id: eventId },
      data: { status: "voided", updatedAt: new Date() },
    });

    return corsJson({
      ok: true,
      event: {
        id: updated.id,
        status: updated.status,
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
