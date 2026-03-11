/**
 * POST /api/settlements/preview
 * 要件書 §21.3: 精算プレビュー
 *
 * 集計結果を計算して返す（DB保存なし）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
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
    const { locationId, locationName, targetDate } = body;

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
