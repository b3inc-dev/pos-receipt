/**
 * POST /api/special-refunds/:id/recheck
 *
 * 前からある（ID が `pos_sr_` で始まらない）特殊返金の登録が、Shopify 返金の結果が分からないまま
 * （shopifyRefundStatus = pending）残ったときに、Shopify の注文の返金を読み直して決める。
 *
 * - Shopify の返金は **実行しない**（読むだけ）。前からの登録は冪等キーも印も無いため、
 *   もう一度実行すると 2 回返金になるおそれがある
 * - 決める前に毎回 Shopify を読み直す（店の人が選んだ内容も、読み直した結果と照らす）
 * - `pos_sr_` の登録は、同じキーで POST /api/special-refunds に送る道を使う（ここでは受けない）
 *
 * body: { resolution?: "link" | "no_refund", refundId?: string }
 */
import { syncOrderAdjustmentsMetafield } from "../services/orderAdjustments.server";
import { countDateOf } from "../services/orderAdjustmentsPure.server";
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { adminGraphqlWithRetry } from "../lib/shopifyGraphqlThrottle.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import { syncRefundAggregationMetafieldForOrder } from "../services/refundAggregation.server";
import { setOrderRefundAggregationLocationGid } from "../services/posOrderMetafields.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  classifyRefundsForLegacyRecheck,
  decideLegacyRecheck,
  isLegacySpecialRefundEventId,
  LEGACY_RECHECK_NO_REFUND_NOTE,
  type OrderRefundForRecheck,
} from "../services/specialRefundLegacyRecheck.server";
import { normalizeLocationGid } from "../utils/locationGid";

const ORDER_REFUNDS_QUERY = `#graphql
  query OrderRefundsForSpecialRefundRecheck($id: ID!) {
    order(id: $id) {
      id
      refunds {
        id
        note
        createdAt
        totalRefundedSet {
          shopMoney {
            amount
          }
        }
      }
    }
  }
`;

function orderGidOf(sourceOrderId: string): string {
  const s = String(sourceOrderId).trim();
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/Order/${s.replace(/\D/g, "")}`;
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

    const eventId = String(params.id ?? "");
    if (!eventId) return corsJson({ ok: false, error: "id required" }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const resolutionRaw = String(body.resolution ?? "").trim();
    const resolution =
      resolutionRaw === "link" || resolutionRaw === "no_refund" ? resolutionRaw : null;
    const refundId = body.refundId != null ? String(body.refundId) : null;

    const event = await prisma.specialRefundEvent.findFirst({
      where: { id: eventId, shopId: shop.id },
    });
    if (!event) return corsJson({ ok: false, error: "Event not found" }, { status: 404 });
    if (event.status !== "active" || event.shopifyRefundStatus !== "pending") {
      return corsJson({
        ok: true,
        resolved: true,
        alreadyResolved: true,
        shopifyRefund: { status: event.shopifyRefundStatus, refundId: event.shopifyRefundId },
      });
    }
    if (!isLegacySpecialRefundEventId(event.id)) {
      return corsJson(
        {
          ok: false,
          error:
            "この登録は「Shopify 返金を確かめる」（同じ登録のまま送り直す）で確かめてください。",
        },
        { status: 400 },
      );
    }

    // 毎回 Shopify を読み直す
    const json = await adminGraphqlWithRetry<{
      data?: { order?: { id?: string; refunds?: OrderRefundForRecheck[] } | null };
      errors?: { message?: string }[];
    }>(admin, ORDER_REFUNDS_QUERY, { variables: { id: orderGidOf(event.sourceOrderId) } });
    if (json.errors?.length || !json.data?.order?.id) {
      return corsJson(
        {
          ok: false,
          retryable: true,
          error: "Shopify の注文を読めませんでした。時間をおいて、もう一度確かめてください。",
        },
        { status: 503 },
      );
    }

    const linked = await prisma.specialRefundEvent.findMany({
      where: {
        shopId: shop.id,
        sourceOrderId: event.sourceOrderId,
        id: { not: event.id },
        shopifyRefundId: { not: null },
      },
      select: { shopifyRefundId: true },
    });
    const linkedRefundIds = new Set<string>();
    for (const row of linked as Array<{ shopifyRefundId: string | null }>) {
      if (row.shopifyRefundId) linkedRefundIds.add(row.shopifyRefundId);
    }

    const classification = classifyRefundsForLegacyRecheck(
      { id: event.id, eventType: event.eventType, amount: event.amount, createdAt: event.createdAt },
      json.data.order.refunds ?? [],
      linkedRefundIds,
    );
    const decision = decideLegacyRecheck(classification, { resolution, refundId });

    if (decision.action === "needs_decision") {
      return corsJson({
        ok: true,
        resolved: false,
        reason: decision.reason,
        candidates: decision.candidates,
      });
    }
    if (decision.action === "reject") {
      return corsJson(
        { ok: false, error: decision.error, candidates: decision.candidates },
        { status: 409 },
      );
    }

    const data =
      decision.action === "success"
        ? {
            shopifyRefundStatus: "success",
            shopifyRefundId: decision.refundId,
            shopifyRefundError: null,
            shopifyRefundProcessedAt: new Date(),
          }
        : {
            shopifyRefundStatus: "failed",
            shopifyRefundError: LEGACY_RECHECK_NO_REFUND_NOTE,
            shopifyRefundProcessedAt: new Date(),
          };

    // 同時に押されても、pending のものだけを 1 回だけ変える
    const updated = await prisma.specialRefundEvent.updateMany({
      where: { id: event.id, shopId: shop.id, status: "active", shopifyRefundStatus: "pending" },
      data,
    });
    const after = await prisma.specialRefundEvent.findUnique({ where: { id: event.id } });
    if (updated.count === 0) {
      return corsJson({
        ok: true,
        resolved: true,
        alreadyResolved: true,
        shopifyRefund: { status: after?.shopifyRefundStatus, refundId: after?.shopifyRefundId },
      });
    }
    console.info("[special-refunds] legacy pending resolved", {
      shopId: shop.id,
      eventId: event.id,
      status: data.shopifyRefundStatus,
      reason: decision.action === "success" ? decision.reason : "no_refund",
    });

    // POST /api/special-refunds で pending 以外になったときと同じあとの処理
    try {
      const processingGid = normalizeLocationGid(event.locationId);
      const orderGid = orderGidOf(event.sourceOrderId);
      if (processingGid) {
        await setOrderRefundAggregationLocationGid(admin, orderGid, processingGid);
      } else {
        await syncRefundAggregationMetafieldForOrder(admin, shop.id, orderGid);
      }
    } catch {
      // メタフィールド同期失敗でも確かめ直し自体は成功させる
    }
    // 注文メタフィールド pos.adjustments の Shopify 返金の状態も書き直す（失敗しても確かめ直しは成功）
    await syncOrderAdjustmentsMetafield(admin, shop.id, event.sourceOrderId);
    const locationGid = normalizeLocationGid(event.locationId);
    if (locationGid) {
      try {
        const timezone = await getShopTimezoneForDaily(admin, shop.id);
        const targetDate = countDateOf(event, timezone);
        const loc = await prisma.location.findFirst({
          where: { shopId: shop.id, shopifyLocationGid: locationGid },
          select: { name: true },
        });
        await computeAndCacheDailySummary(admin, shop.id, locationGid, loc?.name ?? "", targetDate);
      } catch {
        // キャッシュ更新失敗で確かめ直し自体は失敗させない
      }
    }

    return corsJson({
      ok: true,
      resolved: true,
      shopifyRefund: {
        status: after?.shopifyRefundStatus ?? data.shopifyRefundStatus,
        refundId: after?.shopifyRefundId ?? null,
        error: after?.shopifyRefundError ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
