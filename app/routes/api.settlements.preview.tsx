/**
 * POST /api/settlements/preview
 * 要件書 §21.3: 精算プレビュー
 *
 * 集計結果を計算して返す（DB保存なし）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsPreflightResponse } from "../utils/posAuth.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";
import { upsertDailySummaryCacheFromPreview } from "../services/salesSummaryEngine.server";
import { settlementApiErrorResponse } from "../utils/settlementApiError.server";

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

    // プレビュー結果で日次キャッシュのみ更新（Shopify の二重呼び出しを避ける）
    try {
      await upsertDailySummaryCacheFromPreview(
        shop.id,
        String(locationId),
        String(targetDate),
        preview,
      );
    } catch {
      // キャッシュ更新失敗は精算プレビュー表示には影響させない
    }

    return corsJson({ ok: true, preview });
  } catch (err) {
    return settlementApiErrorResponse(request, err);
  }
}
