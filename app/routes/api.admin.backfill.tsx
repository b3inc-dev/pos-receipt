/**
 * POST /api/admin/backfill
 * 管理画面用：過去データ一括取込（1日単位）
 * Body: { locationId, locationName, targetDate, skipExisting? }
 * - skipExisting=true（デフォルト）: キャッシュ済みの日はスキップ
 * - skipExisting=false: 強制再計算
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = await resolveShop(session.shop, admin);

    const body = await request.json() as Record<string, unknown>;
    const { locationId, locationName, targetDate, skipExisting = true } = body;

    if (!locationId || !targetDate) {
      return Response.json(
        { ok: false, error: "locationId and targetDate are required" },
        { status: 400 }
      );
    }

    const locStr = String(locationId);
    const locationGid = locStr.startsWith("gid://")
      ? locStr
      : `gid://shopify/Location/${locStr}`;
    const dateStr = String(targetDate);

    // 未来日はスキップ
    const today = new Date().toISOString().slice(0, 10);
    if (dateStr > today) {
      return Response.json({ ok: true, skipped: true, reason: "future_date", targetDate: dateStr });
    }

    // skipExisting=true のとき既存キャッシュがあればスキップ
    if (skipExisting) {
      const existing = await prisma.salesSummaryCacheDaily.findFirst({
        where: { shopId: shop.id, locationId: locationGid, targetDate: dateStr },
        select: { id: true },
      });
      if (existing) {
        return Response.json({ ok: true, skipped: true, reason: "already_cached", targetDate: dateStr });
      }
    }

    // Shopify API で集計・キャッシュ更新
    await computeAndCacheDailySummary(
      admin,
      shop.id,
      locationGid,
      String(locationName ?? ""),
      dateStr
    );

    return Response.json({ ok: true, skipped: false, targetDate: dateStr });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
