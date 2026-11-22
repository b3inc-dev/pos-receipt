/**
 * 特殊返金の登録のあとの処理（Shopify 返金・返金計上店のメタフィールド・日次キャッシュ）。
 * POS の登録（api.special-refunds）と管理画面の承認（app.special-refund-history）で同じものを使う。
 */
import prisma from "../db.server";
import type { DEFAULT_SPECIAL_REFUND_SETTINGS } from "../utils/appSettings.server";
import { computeAndCacheDailySummary } from "./salesSummaryEngine.server";
import { syncRefundAggregationMetafieldForOrder } from "./refundAggregation.server";
import { setOrderRefundAggregationLocationGid } from "./posOrderMetafields.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { executeShopifyRefundForEvent, shouldExecuteShopifyRefund } from "./shopifyRefundExecute.server";
import { checkApprovalTransition, type ApprovalDecision } from "./specialRefundApproval";

export const CORRECTION_SKIP_REASON =
  "訂正登録のため記録のみ（同一取引に無効化済みイベントがあります）";

type AdminGraphql = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

export function normalizeLocationIdToGid(locationId: string): string | null {
  const s = String(locationId || "").trim();
  if (!s) return null;
  if (s.startsWith("gid://shopify/Location/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ? `gid://shopify/Location/${m[1]}` : null;
}

/**
 * 訂正のときの「記録のみ」を決める無効化済みの件数。
 * 承認待ちのまま無効化した・却下した登録は Shopify 返金をしていないので数えない。
 */
export async function countVoidedEventsOnOrder(shopId: string, sourceOrderId: string): Promise<number> {
  return prisma.specialRefundEvent.count({
    where: {
      shopId,
      sourceOrderId,
      status: "voided",
      approvalStatus: { in: ["not_required", "approved"] },
    },
  });
}

export async function applyShopifyRefundToEvent(
  admin: { graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }> },
  settings: typeof DEFAULT_SPECIAL_REFUND_SETTINGS,
  event: {
    id: string;
    sourceOrderId: string;
    eventType: string;
    amount: { toString(): string };
    adjustKind: string | null;
  },
  opts: {
    originalPaymentMethod: string | null;
    actualRefundMethod: string | null;
    note: string | null;
    isCorrectionRegistration: boolean;
  },
) {
  if (opts.isCorrectionRegistration) {
    return prisma.specialRefundEvent.update({
      where: { id: event.id },
      data: {
        shopifyRefundStatus: "skipped",
        shopifyRefundError: CORRECTION_SKIP_REASON,
      },
    });
  }

  if (!shouldExecuteShopifyRefund(settings, event.eventType, event.adjustKind)) {
    return prisma.specialRefundEvent.update({
      where: { id: event.id },
      data: { shopifyRefundStatus: "skipped", shopifyRefundError: null },
    });
  }

  await prisma.specialRefundEvent.update({
    where: { id: event.id },
    data: { shopifyRefundStatus: "pending" },
  });

  const result = await executeShopifyRefundForEvent(admin, {
    sourceOrderId: event.sourceOrderId,
    amount: Number(event.amount),
    eventType: event.eventType,
    note: opts.note,
    originalPaymentMethod: opts.originalPaymentMethod,
    actualRefundMethod: opts.actualRefundMethod,
    adjustKind: event.adjustKind,
    idempotencyKey: event.id,
  });

  if (result.status === "success") {
    return prisma.specialRefundEvent.update({
      where: { id: event.id },
      data: {
        shopifyRefundStatus: "success",
        shopifyRefundId: result.refundId,
        shopifyRefundError: null,
        shopifyRefundProcessedAt: new Date(),
      },
    });
  }

  if (result.status === "skipped") {
    return prisma.specialRefundEvent.update({
      where: { id: event.id },
      data: {
        shopifyRefundStatus: "skipped",
        shopifyRefundError: result.reason,
      },
    });
  }

  if (result.status === "retryable") {
    return prisma.specialRefundEvent.update({
      where: { id: event.id },
      data: {
        // 同一payload・同一イベントIDで再開できる状態を維持する。
        shopifyRefundStatus: "pending",
        shopifyRefundError: result.error,
        shopifyRefundProcessedAt: null,
      },
    });
  }

  return prisma.specialRefundEvent.update({
    where: { id: event.id },
    data: {
      shopifyRefundStatus: "failed",
      shopifyRefundError: result.error,
      shopifyRefundProcessedAt: new Date(),
    },
  });
}

/** 返金計上店のメタフィールドと、登録日の日次キャッシュをそろえる（失敗しても登録は成功のまま） */
export async function syncAfterSpecialRefundProcessed(
  admin: AdminGraphql,
  shopId: string,
  event: { sourceOrderId: string; locationId: string; createdAt: Date },
): Promise<void> {
  const orderGid = String(event.sourceOrderId).startsWith("gid://")
    ? String(event.sourceOrderId)
    : `gid://shopify/Order/${String(event.sourceOrderId).replace(/\D/g, "")}`;
  const locationGid = normalizeLocationIdToGid(event.locationId);
  try {
    if (locationGid) {
      await setOrderRefundAggregationLocationGid(admin, orderGid, locationGid);
    } else {
      await syncRefundAggregationMetafieldForOrder(admin, shopId, orderGid);
    }
  } catch {
    // メタフィールド同期失敗でもイベント登録は成功させる
  }

  await recomputeDailySummaryForEvent(admin, shopId, event);
}

/** 売上サマリー（過去実績含む）の整合を保つため、登録日の日次キャッシュを再計算 */
export async function recomputeDailySummaryForEvent(
  admin: AdminGraphql,
  shopId: string,
  event: { locationId: string; createdAt: Date },
): Promise<void> {
  const locationGid = normalizeLocationIdToGid(event.locationId);
  if (!locationGid) return;
  try {
    const timezone = await getShopTimezoneForDaily(admin, shopId);
    const targetDate = getCalendarDateStringInTimeZone(event.createdAt, timezone);
    const loc = await prisma.location.findFirst({
      where: { shopId, shopifyLocationGid: locationGid },
      select: { name: true },
    });
    await computeAndCacheDailySummary(admin, shopId, locationGid, loc?.name ?? "", targetDate);
  } catch {
    // キャッシュ更新失敗でイベント登録自体は失敗させない
  }
}

export type DecideApprovalResult =
  | {
      ok: true;
      approvalStatus: "approved" | "rejected";
      shopifyRefundStatus: string;
      shopifyRefundError: string | null;
      /** その日・その店の精算がもう作られている（数字を出し直す必要がある） */
      settlementAlreadyExists: boolean;
    }
  | { ok: false; error: string; retryable?: boolean };

/**
 * 管理画面から承認・却下する。
 * - 承認: 承認待ち → approved にしてから、まだ Shopify 返金の段に入っていなければ実行する（冪等キーは登録の ID）。
 *   Shopify 返金の結果が分からない（pending）ときは、同じボタンでもう一度実行できる（2 回返金にはならない）。
 * - 却下: 承認待ち → rejected。Shopify 返金はしない。精算・売上サマリーに入れない。
 */
export async function decideSpecialRefundApproval(
  admin: AdminGraphql,
  shopId: string,
  settings: typeof DEFAULT_SPECIAL_REFUND_SETTINGS,
  input: { eventId: string; decision: ApprovalDecision; decidedBy: string | null; note?: string | null },
): Promise<DecideApprovalResult> {
  const event = await prisma.specialRefundEvent.findFirst({
    where: { id: input.eventId, shopId },
  });
  if (!event) return { ok: false, error: "登録が見つかりません。画面を読み直してください。" };

  const isRetry =
    input.decision === "approve" &&
    event.status === "active" &&
    event.approvalStatus === "approved" &&
    event.shopifyRefundStatus === "pending";

  if (!isRetry) {
    const check = checkApprovalTransition(event, input.decision);
    if (!check.ok) return { ok: false, error: check.reason };

    const willRefund =
      check.next === "approved" &&
      event.shopifyRefundStatus === "none" &&
      shouldExecuteShopifyRefund(settings, event.eventType, event.adjustKind);

    // 同時に押されても 1 回だけ進むよう、承認待ちのときだけ書き換える。
    // Shopify 返金をする登録は、ここで pending にしておく（途中で落ちても「数えない・確かめる」側に倒す）。
    const claimed = await prisma.specialRefundEvent.updateMany({
      where: { id: event.id, shopId, status: "active", approvalStatus: "pending" },
      data: {
        approvalStatus: check.next,
        approvalDecidedAt: new Date(),
        approvalDecidedBy: input.decidedBy,
        approvalNote: input.note?.trim() ? input.note.trim() : null,
        ...(willRefund ? { shopifyRefundStatus: "pending" } : {}),
      },
    });
    if (claimed.count !== 1) {
      return { ok: false, error: "ほかの操作で状態が変わりました。画面を読み直してください。" };
    }
  }

  let current = await prisma.specialRefundEvent.findUniqueOrThrow({ where: { id: event.id } });

  if (current.approvalStatus === "approved" && ["none", "pending"].includes(current.shopifyRefundStatus)) {
    current = await applyShopifyRefundToEvent(admin, settings, current, {
      originalPaymentMethod: current.originalPaymentMethod,
      actualRefundMethod: current.actualRefundMethod,
      note: current.note,
      // 訂正（記録のみ）は POS の登録の時点で skipped にしてあるので、ここまで来た登録は訂正ではない
      isCorrectionRegistration: false,
    });
    if (current.shopifyRefundStatus === "pending") {
      return {
        ok: false,
        retryable: true,
        error:
          "承認しましたが、Shopify 返金の結果が分かりません。この日の精算は止まります。Shopify の管理画面で返金の有無を確かめてから、もう一度「承認する」を押してください（返金は 2 回になりません）。" +
          (current.shopifyRefundError ? `（${current.shopifyRefundError}）` : ""),
      };
    }
    await syncAfterSpecialRefundProcessed(admin, shopId, current);
  } else {
    await recomputeDailySummaryForEvent(admin, shopId, current);
  }

  const settlementAlreadyExists = await hasSettlementForEventDay(admin, shopId, current);

  return {
    ok: true,
    approvalStatus: current.approvalStatus === "rejected" ? "rejected" : "approved",
    shopifyRefundStatus: current.shopifyRefundStatus,
    shopifyRefundError: current.shopifyRefundError,
    settlementAlreadyExists,
  };
}

/** 登録の日・店の精算がもう作られているか（作り直しの案内に使う。読めなければ false） */
async function hasSettlementForEventDay(
  admin: AdminGraphql,
  shopId: string,
  event: { locationId: string; createdAt: Date },
): Promise<boolean> {
  const locationGid = normalizeLocationIdToGid(event.locationId);
  if (!locationGid) return false;
  try {
    const timezone = await getShopTimezoneForDaily(admin, shopId);
    const targetDate = getCalendarDateStringInTimeZone(event.createdAt, timezone);
    const numeric = locationGid.replace(/^gid:\/\/shopify\/Location\//, "");
    const count = await prisma.settlement.count({
      where: {
        shopId,
        targetDate,
        locationId: { in: [locationGid, numeric] },
        status: { in: ["completed", "printed"] },
        // 点検（periodLabel が 点検_…）は数字を残すだけなので除く
        NOT: { periodLabel: { startsWith: "点検_" } },
      },
    });
    return count > 0;
  } catch {
    return false;
  }
}
