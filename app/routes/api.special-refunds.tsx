/**
 * GET  /api/special-refunds?sourceOrderId=...
 * POST /api/special-refunds
 * 要件書 21.4: 特殊返金イベント 一覧取得・登録
 * 設定 §8: 有効なイベント種別は特殊返金設定に従う
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { getAppSetting } from "../utils/appSettings.server";
import { SPECIAL_REFUND_SETTINGS_KEY, DEFAULT_SPECIAL_REFUND_SETTINGS } from "../utils/appSettings.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import { syncRefundAggregationMetafieldForOrder } from "../services/refundAggregation.server";
import { setOrderRefundAggregationLocationGid } from "../services/posOrderMetafields.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  executeShopifyRefundForEvent,
  shouldExecuteShopifyRefund,
} from "../services/shopifyRefundExecute.server";

const EVENT_TYPES = ["cash_refund", "payment_method_override", "voucher_change_adjustment", "receipt_cash_adjustment"] as const;

function getAllowedEventTypes(settings: typeof DEFAULT_SPECIAL_REFUND_SETTINGS | null): string[] {
  const s = settings ?? DEFAULT_SPECIAL_REFUND_SETTINGS;
  const out: string[] = [];
  if (s.enableCashRefund) out.push("cash_refund");
  if (s.enablePaymentMethodOverride) out.push("payment_method_override");
  if (s.enableVoucherChangeAdjustment) out.push("voucher_change_adjustment");
  if (s.enableReceiptCashAdjustment) out.push("receipt_cash_adjustment");
  return out.length > 0 ? out : [...EVENT_TYPES];
}

const CORRECTION_SKIP_REASON =
  "訂正登録のため記録のみ（同一取引に無効化済みイベントがあります）";

async function countVoidedEventsOnOrder(shopId: string, sourceOrderId: string): Promise<number> {
  return prisma.specialRefundEvent.count({
    where: { shopId, sourceOrderId, status: "voided" },
  });
}

function normalizeLocationIdToGid(locationId: string): string | null {
  const s = String(locationId || "").trim();
  if (!s) return null;
  if (s.startsWith("gid://shopify/Location/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ? `gid://shopify/Location/${m[1]}` : null;
}

// GET /api/special-refunds?sourceOrderId=...
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const settings = await getAppSetting<typeof DEFAULT_SPECIAL_REFUND_SETTINGS>(shop.id, SPECIAL_REFUND_SETTINGS_KEY);
    const merged = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...settings };
    const allowedTypes = getAllowedEventTypes(merged);

    const url = new URL(request.url);
    const sourceOrderId = url.searchParams.get("sourceOrderId");

    if (!sourceOrderId) {
      return corsJson(
        { ok: false, error: "sourceOrderId is required" },
        { status: 400 }
      );
    }

    const items = await prisma.specialRefundEvent.findMany({
      where: {
        shopId: shop.id,
        sourceOrderId,
        eventType: { in: allowedTypes },
      },
      orderBy: { createdAt: "desc" },
    });

    const voidedCount = await countVoidedEventsOnOrder(shop.id, sourceOrderId);

    return corsJson({
      items: items.map(serializeEvent),
      allowedEventTypes: allowedTypes,
      refundProcessingMode: merged.refundProcessingMode,
      orderCorrectionContext: {
        hasVoidedEvents: voidedCount > 0,
        nextRegistrationRecordOnly:
          merged.correctionUsesRecordOnly && voidedCount > 0,
      },
      uiLabels: {
        specialRefund: merged.specialRefundUiLabel,
        voucherAdjustment: merged.voucherAdjustmentUiLabel,
        cashRefund: merged.cashRefundUiLabel,
        paymentOverride: merged.paymentOverrideUiLabel,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

// POST /api/special-refunds
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    if (request.method !== "POST") {
      return corsJson({ error: "Method not allowed" }, { status: 405 });
    }

    const settings = await getAppSetting<typeof DEFAULT_SPECIAL_REFUND_SETTINGS>(shop.id, SPECIAL_REFUND_SETTINGS_KEY);
    const merged = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...settings };
    const allowedTypes = getAllowedEventTypes(merged);

    const body = await request.json() as Record<string, unknown>;
    const {
      sourceOrderId,
      sourceOrderName,
      locationId,
      eventType,
      amount,
      currency,
      originalPaymentMethod,
      actualRefundMethod,
      voucherFaceValue,
      voucherAppliedAmount,
      voucherChangeAmount,
      adjustKind,
      note,
      createdBy,
    } = body;

    if (!sourceOrderId || !eventType || amount == null) {
      return corsJson(
        { ok: false, error: "sourceOrderId, eventType, amount are required" },
        { status: 400 }
      );
    }
    if (!allowedTypes.includes(String(eventType))) {
      return corsJson(
        { ok: false, error: `eventType must be one of: ${allowedTypes.join(", ")}` },
        { status: 400 }
      );
    }

    const eventTypeStr = String(eventType);
    const adjustKindStr = adjustKind ? String(adjustKind) : null;
    const sourceOrderIdStr = String(sourceOrderId);
    const voidedOnOrder = await countVoidedEventsOnOrder(shop.id, sourceOrderIdStr);
    const isCorrectionRegistration =
      merged.correctionUsesRecordOnly && voidedOnOrder > 0;

    let event = await prisma.specialRefundEvent.create({
      data: {
        shopId: shop.id,
        sourceOrderId: sourceOrderIdStr,
        sourceOrderName: sourceOrderName ? String(sourceOrderName) : null,
        locationId: locationId ? String(locationId) : "",
        eventType: eventTypeStr,
        amount: Number(amount),
        currency: currency ? String(currency) : "JPY",
        originalPaymentMethod: originalPaymentMethod ? String(originalPaymentMethod) : null,
        actualRefundMethod: actualRefundMethod ? String(actualRefundMethod) : null,
        voucherFaceValue: voucherFaceValue != null ? Number(voucherFaceValue) : null,
        voucherAppliedAmount: voucherAppliedAmount != null ? Number(voucherAppliedAmount) : null,
        voucherChangeAmount: voucherChangeAmount != null ? Number(voucherChangeAmount) : null,
        adjustKind: adjustKindStr,
        note: note ? String(note) : null,
        createdBy: createdBy ? String(createdBy) : null,
        status: "active",
        shopifyRefundStatus: "none",
      },
    });

    event = await applyShopifyRefundToEvent(admin, merged, event, {
      originalPaymentMethod: originalPaymentMethod ? String(originalPaymentMethod) : null,
      actualRefundMethod: actualRefundMethod ? String(actualRefundMethod) : null,
      note: note ? String(note) : null,
      isCorrectionRegistration,
    });

    const orderGid = String(sourceOrderId).startsWith("gid://")
      ? String(sourceOrderId)
      : `gid://shopify/Order/${String(sourceOrderId).replace(/\D/g, "")}`;
    try {
      const processingGid = normalizeLocationIdToGid(locationId ? String(locationId) : "");
      if (processingGid) {
        await setOrderRefundAggregationLocationGid(admin, orderGid, processingGid);
      } else {
        await syncRefundAggregationMetafieldForOrder(admin, shop.id, orderGid);
      }
    } catch {
      // メタフィールド同期失敗でもイベント登録は成功させる
    }

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
        event: serializeEvent(event),
        correctionRegistration: isCorrectionRegistration,
        shopifyRefund: {
          status: event.shopifyRefundStatus,
          refundId: event.shopifyRefundId,
          error: event.shopifyRefundError,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

async function applyShopifyRefundToEvent(
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

  return prisma.specialRefundEvent.update({
    where: { id: event.id },
    data: {
      shopifyRefundStatus: "failed",
      shopifyRefundError: result.error,
      shopifyRefundProcessedAt: new Date(),
    },
  });
}

function serializeEvent(e: {
  id: string;
  shopId: string;
  sourceOrderId: string;
  sourceOrderName: string | null;
  locationId: string;
  eventType: string;
  originalPaymentMethod: string | null;
  actualRefundMethod: string | null;
  amount: { toString(): string };
  currency: string | null;
  voucherFaceValue: { toString(): string } | null;
  voucherAppliedAmount: { toString(): string } | null;
  voucherChangeAmount: { toString(): string } | null;
  adjustKind: string | null;
  note: string | null;
  createdBy: string | null;
  status: string;
  shopifyRefundStatus: string;
  shopifyRefundId: string | null;
  shopifyRefundError: string | null;
  shopifyRefundProcessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: e.id,
    sourceOrderId: e.sourceOrderId,
    sourceOrderName: e.sourceOrderName,
    locationId: e.locationId,
    eventType: e.eventType,
    originalPaymentMethod: e.originalPaymentMethod,
    actualRefundMethod: e.actualRefundMethod,
    amount: e.amount.toString(),
    currency: e.currency,
    voucherFaceValue: e.voucherFaceValue?.toString() ?? null,
    voucherAppliedAmount: e.voucherAppliedAmount?.toString() ?? null,
    voucherChangeAmount: e.voucherChangeAmount?.toString() ?? null,
    adjustKind: e.adjustKind,
    note: e.note,
    createdBy: e.createdBy,
    status: e.status,
    shopifyRefundStatus: e.shopifyRefundStatus,
    shopifyRefundId: e.shopifyRefundId,
    shopifyRefundError: e.shopifyRefundError,
    shopifyRefundProcessedAt: e.shopifyRefundProcessedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}
