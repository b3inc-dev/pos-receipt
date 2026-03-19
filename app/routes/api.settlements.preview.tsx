/**
 * POST /api/settlements/preview
 * 要件書 §21.3: 精算プレビュー
 *
 * 集計結果を計算して返す（DB保存なし）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
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

    // 精算と同様に、該当日の売上サマリーキャッシュを更新（期間表示と数値の一貫性を保つ）
    try {
      await computeAndCacheDailySummary(
        admin,
        shop.id,
        String(locationId),
        String(locationName ?? ""),
        String(targetDate),
      );
    } catch {
      // キャッシュ更新失敗は精算結果に影響させない
    }

    return corsJson({ ok: true, preview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
