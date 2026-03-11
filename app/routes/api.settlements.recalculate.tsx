/**
 * POST /api/settlements/recalculate
 * 要件書 §21.3: 精算再集計
 *
 * Body: { settlementId } or { locationId, locationName, targetDate }
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

    const body = await request.json() as Record<string, unknown>;
    let { locationId, locationName, targetDate } = body;
    const { settlementId } = body;

    // settlementId が指定された場合は既存レコードから取得
    if (settlementId && !locationId) {
      const existing = await prisma.settlement.findFirst({
        where: { id: String(settlementId), shopId: shop.id },
      });
      if (!existing) {
        return Response.json({ ok: false, error: "Settlement not found" }, { status: 404 });
      }
      locationId = existing.locationId;
      targetDate = existing.targetDate;
    }

    if (!locationId || !targetDate) {
      return Response.json(
        { ok: false, error: "locationId and targetDate are required" },
        { status: 400 }
      );
    }

    const preview = await buildSettlementPreview(
      admin,
      shop.id,
      String(locationId),
      String(locationName ?? ""),
      String(targetDate),
    );

    return Response.json({ ok: true, preview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
