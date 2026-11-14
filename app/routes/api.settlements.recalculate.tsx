/**
 * POST /api/settlements/recalculate
 * 要件書 §21.3: 精算再集計
 *
 * ライブ再集計はプレビュー／日次キャッシュのみ。Shopify 精算注文は更新しない。
 * 再印刷は保存済み Settlement を使う（本 API は帳票スナップショットを書き換えない）。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";
import { upsertDailySummaryCacheFromPreview } from "../services/salesSummaryEngine.server";
import { settlementApiErrorResponse } from "../utils/settlementApiError.server";
import prisma from "../db.server";

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

    if (settlementId && !locationId) {
      const existing = await prisma.settlement.findFirst({
        where: { id: String(settlementId), shopId: shop.id },
      });
      if (!existing) {
        return corsJson({ ok: false, error: "Settlement not found" }, { status: 404 });
      }
      locationId = existing.locationId;
      targetDate = existing.targetDate;
      if (!locationName) {
        const locIdStr = String(locationId);
        const locIdGid = locIdStr.startsWith("gid://") ? locIdStr : `gid://shopify/Location/${locIdStr}`;
        const loc = await prisma.location.findFirst({
          where: { shopId: shop.id, shopifyLocationGid: locIdGid },
        });
        locationName = loc?.name ?? "";
      }
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

    try {
      await upsertDailySummaryCacheFromPreview(
        shop.id,
        String(locationId),
        String(targetDate),
        preview,
      );
    } catch {
      // キャッシュ更新失敗は精算結果に影響させない
    }

    return corsJson({
      ok: true,
      preview,
      sourceOrderId: null,
      sourceOrderName: null,
    });
  } catch (err) {
    return settlementApiErrorResponse(request, err);
  }
}
