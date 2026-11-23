/**
 * 返金処理中（pending）のまま数分たった特殊返金を、アプリが自動で Shopify を読み直して決める（T 2026-11-23 4:25）。
 *
 * 呼ばれる所:
 * 1. 精算プレビュー・点検・確定の集計の最初（その日・そのロケーションの登録だけ）
 * 2. POS の特殊返金の一覧（その注文の登録だけ）
 * 3. 定期の見回り（pg-boss・5 分ごと・全店。specialRefundAutoResolveQueue.server.ts）
 *
 * Shopify は読むだけで、返金は作らない。決め方は specialRefundAutoResolvePure.server.ts。
 */
import prisma from "../db.server";
import { adminGraphqlWithRetry, type AdminGraphqlClient } from "../lib/shopifyGraphqlThrottle.server";
import { syncRefundAggregationMetafieldForOrder } from "./refundAggregation.server";
import { setOrderRefundAggregationLocationGid } from "./posOrderMetafields.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { normalizeLocationGid } from "../utils/locationGid";
import type { OrderRefundForRecheck } from "./specialRefundLegacyRecheck.server";
import {
  ORDER_REFUNDS_FOR_AUTO_RESOLVE_QUERY,
  orderGidOf,
  resolveStalePendingSpecialRefundsCore,
  type AutoResolveDb,
  type AutoResolveResult,
  type AutoResolveScope,
  type AutoResolvedEvent,
} from "./specialRefundAutoResolveCore.server";
import { autoResolveAfterMs, isAutoResolveDisabled } from "./specialRefundAutoResolvePure.server";

export function makeReadOrderRefunds(admin: AdminGraphqlClient) {
  return async (orderGid: string): Promise<OrderRefundForRecheck[] | null> => {
    const json = await adminGraphqlWithRetry<{
      data?: { order?: { id?: string; refunds?: OrderRefundForRecheck[] } | null };
      errors?: { message?: string }[];
    }>(admin, ORDER_REFUNDS_FOR_AUTO_RESOLVE_QUERY, { variables: { id: orderGid } });
    if (json.errors?.length || !json.data?.order?.id) return null;
    return json.data.order.refunds ?? [];
  };
}

/**
 * pending の登録が success / failed になったあとの処理（POST /api/special-refunds で
 * pending 以外になったときと同じ）: 返金の計上ロケーションのメタフィールドと、売上サマリーの日次キャッシュ。
 * どちらも失敗しても、決めた結果は戻さない。
 */
export async function afterSpecialRefundsResolved(
  admin: AdminGraphqlClient,
  shopId: string,
  resolved: AutoResolvedEvent[],
  opts: { refreshDailySummary: boolean },
): Promise<void> {
  const orders = new Map<string, string>();
  for (const e of resolved) orders.set(e.sourceOrderId, e.locationId);
  for (const [sourceOrderId, locationId] of orders) {
    try {
      const processingGid = normalizeLocationGid(locationId);
      const orderGid = orderGidOf(sourceOrderId);
      if (processingGid) {
        await setOrderRefundAggregationLocationGid(admin, orderGid, processingGid);
      } else {
        await syncRefundAggregationMetafieldForOrder(admin, shopId, orderGid);
      }
    } catch {
      // メタフィールド同期失敗でも決めた結果はそのまま
    }
  }
  if (!opts.refreshDailySummary) return;

  let timezone: string | null = null;
  const days = new Map<string, { locationGid: string; targetDate: string }>();
  for (const e of resolved) {
    const locationGid = normalizeLocationGid(e.locationId);
    if (!locationGid) continue;
    try {
      timezone ??= await getShopTimezoneForDaily(admin, shopId);
    } catch {
      return;
    }
    const targetDate = getCalendarDateStringInTimeZone(e.createdAt, timezone);
    days.set(`${locationGid}|${targetDate}`, { locationGid, targetDate });
  }
  if (days.size === 0) return;
  // 精算エンジン → この部品 → 売上サマリー → 精算エンジン の循環を避けるため、使うときだけ読む
  const { computeAndCacheDailySummary } = await import("./salesSummaryEngine.server");
  for (const { locationGid, targetDate } of days.values()) {
    try {
      const loc = await prisma.location.findFirst({
        where: { shopId, shopifyLocationGid: locationGid },
        select: { name: true },
      });
      await computeAndCacheDailySummary(admin, shopId, locationGid, loc?.name ?? "", targetDate);
    } catch {
      // キャッシュ更新失敗で決めた結果は戻さない
    }
  }
}

const EMPTY_RESULT: AutoResolveResult = {
  checked: 0,
  resolved: [],
  leftForStaff: [],
  skippedConcurrent: [],
  readFailedOrders: [],
};

/**
 * 範囲の中の「数分たった pending」を読み直して決める。対象が無ければ DB を 1 回読むだけ。
 * @param opts.refreshDailySummary 精算の集計の中から呼ぶときは false（その集計がそのまま使われるため）。
 *   "background" は応答を待たせずに売上サマリーの日次を作り直す
 */
export async function autoResolveStalePendingSpecialRefunds(
  admin: AdminGraphqlClient,
  shopId: string,
  scope: AutoResolveScope,
  opts: { refreshDailySummary: boolean | "background"; limit?: number },
): Promise<AutoResolveResult> {
  if (isAutoResolveDisabled()) return EMPTY_RESULT;
  const result = await resolveStalePendingSpecialRefundsCore(
    {
      db: prisma.specialRefundEvent as unknown as AutoResolveDb,
      readOrderRefunds: makeReadOrderRefunds(admin),
    },
    shopId,
    scope,
    { afterMs: autoResolveAfterMs(), limit: opts.limit },
  );
  if (result.resolved.length > 0) {
    console.info("[special-refunds] auto-resolved stale pending", {
      shopId,
      resolved: result.resolved.map((e) => ({ id: e.id, status: e.status, reason: e.reason })),
    });
    if (opts.refreshDailySummary === "background") {
      // 応答を待たせない（POS の一覧など）。失敗は中で握りつぶす
      void afterSpecialRefundsResolved(admin, shopId, result.resolved, {
        refreshDailySummary: true,
      }).catch(() => {});
    } else {
      await afterSpecialRefundsResolved(admin, shopId, result.resolved, {
        refreshDailySummary: opts.refreshDailySummary,
      });
    }
  }
  if (result.readFailedOrders.length > 0 || result.leftForStaff.length > 0) {
    console.warn("[special-refunds] stale pending left", {
      shopId,
      readFailedOrders: result.readFailedOrders.length,
      leftForStaff: result.leftForStaff.length,
    });
  }
  return result;
}
