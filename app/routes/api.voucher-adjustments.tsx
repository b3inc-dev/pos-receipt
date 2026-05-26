/**
 * POST /api/voucher-adjustments
 * 要件書 21.4: 商品券調整イベント登録（eventType = voucher_change_adjustment）
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
    const {
      sourceOrderId,
      sourceOrderName,
      locationId,
      voucherFaceValue,
      voucherAppliedAmount,
      voucherChangeAmount,
      currency,
      note,
      createdBy,
    } = body;

    if (!sourceOrderId || voucherFaceValue == null || voucherAppliedAmount == null || voucherChangeAmount == null) {
      return corsJson(
        {
          ok: false,
          error: "sourceOrderId, voucherFaceValue, voucherAppliedAmount, voucherChangeAmount are required",
        },
        { status: 400 }
      );
    }

    // amount は voucherChangeAmount を代表値として使用
    const event = await prisma.specialRefundEvent.create({
      data: {
        shopId: shop.id,
        sourceOrderId: String(sourceOrderId),
        sourceOrderName: sourceOrderName ? String(sourceOrderName) : null,
        locationId: locationId ? String(locationId) : "",
        eventType: "voucher_change_adjustment",
        amount: Number(voucherChangeAmount),
        currency: currency ? String(currency) : "JPY",
        voucherFaceValue: Number(voucherFaceValue),
        voucherAppliedAmount: Number(voucherAppliedAmount),
        voucherChangeAmount: Number(voucherChangeAmount),
        note: note ? String(note) : null,
        createdBy: createdBy ? String(createdBy) : null,
        status: "active",
        shopifyRefundStatus: "skipped",
      },
    });

    // 売上サマリー（過去実績含む）の整合を保つため、登録日の日次キャッシュを再計算
    const locationGid = normalizeLocationIdToGid(event.locationId);
    if (locationGid) {
      try {
        const timezone = await getShopTimezoneForDaily(admin, shop.id);
        const targetDate = getCalendarDateStringInTimeZone(event.createdAt, timezone);
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
        // キャッシュ更新失敗でイベント登録自体は失敗させない
      }
    }

    return corsJson(
      {
        ok: true,
        event: {
          id: event.id,
          eventType: event.eventType,
          sourceOrderId: event.sourceOrderId,
          sourceOrderName: event.sourceOrderName,
          amount: event.amount.toString(),
          voucherFaceValue: event.voucherFaceValue?.toString() ?? null,
          voucherAppliedAmount: event.voucherAppliedAmount?.toString() ?? null,
          voucherChangeAmount: event.voucherChangeAmount?.toString() ?? null,
          currency: event.currency,
          note: event.note,
          status: event.status,
          shopifyRefundStatus: event.shopifyRefundStatus,
          createdAt: event.createdAt.toISOString(),
        },
        shopifyRefund: {
          status: "skipped",
          reason: "商品券調整は記録のみ（Shopify自動返金なし）",
        },
      },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
