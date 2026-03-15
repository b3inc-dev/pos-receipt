/**
 * POST /api/settlements/preview
 * 要件書 §21.3: 精算プレビュー
 *
 * 集計結果を計算して返す（DB保存なし）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson } from "../utils/posAuth.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    if (request.method !== "POST") {
      return corsJson({ error: "Method not allowed" }, { status: 405 });
    }

    const body = await request.json() as Record<string, unknown>;
    const { locationId, locationName, targetDate } = body;

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
