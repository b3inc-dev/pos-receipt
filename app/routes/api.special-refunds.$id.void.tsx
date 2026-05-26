/**
 * POST /api/special-refunds/:id/void
 * 要件書 21.4: 特殊返金イベント 無効化
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";

function normalizeLocationIdToGid(locationId: string): string | null {
  const s = String(locationId || "").trim();
  if (!s) return null;
  if (s.startsWith("gid://shopify/Location/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ? `gid://shopify/Location/${m[1]}` : null;
}

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

    // 無効化後の過去実績集計ズレを防ぐため、登録日の日次キャッシュを再計算
    const locationGid = normalizeLocationIdToGid(existing.locationId);
    if (locationGid) {
      try {
        const timezone = await getShopTimezoneForDaily(admin, shop.id);
        const targetDate = getCalendarDateStringInTimeZone(existing.createdAt, timezone);
        const loc = await prisma.location.findFirst({
          where: { shopId: shop.id, shopifyLocationGid: locationGid },
          select: { name: true },
        });
        await computeAndCacheDailySummary(
          admin,
          shop.id,
          locationGid,
          loc?.name ?? "",
          targetDate,
        );
      } catch {
        // キャッシュ更新失敗で void 自体は失敗させない
      }
    }

    let warning: string | null = null;
    if (existing.shopifyRefundStatus === "success") {
      warning =
        "Shopify 上の返金は自動では取り消されません。必要な場合は Shopify 管理画面で手動対応してください。訂正する場合は、正しい内容で再登録してください（再登録は記録のみになります）。";
    } else if (existing.shopifyRefundStatus === "failed") {
      warning =
        "Shopify 返金は失敗しています。無効化後、正しい内容で再登録できます。";
    } else {
      warning =
        "無効化しました。訂正する場合は、正しい内容で再登録してください。";
    }

    return corsJson({
      ok: true,
      event: {
        id: updated.id,
        status: updated.status,
        shopifyRefundStatus: existing.shopifyRefundStatus,
        updatedAt: updated.updatedAt.toISOString(),
      },
      warning,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
