/**
 * POST /api/special-refunds/:id/void
 * 要件書 21.4: 特殊返金イベント 無効化
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

    const eventId = params.id;
    if (!eventId) {
      return Response.json({ ok: false, error: "id required" }, { status: 400 });
    }

    const existing = await prisma.specialRefundEvent.findFirst({
      where: { id: eventId, shopId: shop.id },
    });
    if (!existing) {
      return Response.json({ ok: false, error: "Event not found" }, { status: 404 });
    }
    if (existing.status === "voided") {
      return Response.json({ ok: false, error: "Already voided" }, { status: 409 });
    }

    const updated = await prisma.specialRefundEvent.update({
      where: { id: eventId },
      data: { status: "voided", updatedAt: new Date() },
    });

    return Response.json({
      ok: true,
      event: {
        id: updated.id,
        status: updated.status,
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
