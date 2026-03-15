/**
 * POST /api/settlements/recalculate
 * 要件書 §21.3: 精算再集計
 *
 * Body: { settlementId } or { locationId, locationName, targetDate }
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return corsErrorJson(request, { error: "Method not allowed" }, 405);
  }
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const body = await request.json() as Record<string, unknown>;
    let { locationId, locationName, targetDate } = body;
    const { settlementId } = body;

    // settlementId が指定された場合は既存レコードから取得
    if (settlementId && !locationId) {
      const existing = await prisma.settlement.findFirst({
        where: { id: String(settlementId), shopId: shop.id },
      });
      if (!existing) {
        return corsJson({ ok: false, error: "Settlement not found" }, { status: 404 });
      }
      locationId = existing.locationId;
      targetDate = existing.targetDate;
    }

    if (!locationId || !targetDate) {
      return corsJson(
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

    return corsJson({ ok: true, preview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
