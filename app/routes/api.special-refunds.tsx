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
import {
  matchesSpecialRefundIdempotencyPayload,
  resolveSpecialRefundIdempotencyKey,
} from "../services/specialRefundIdempotency.server";
import {
  applyShopifyRefundToEvent,
  CORRECTION_SKIP_REASON,
  countVoidedEventsOnOrder,
  syncAfterSpecialRefundProcessed,
} from "../services/specialRefundProcess.server";
import { initialApprovalStatus, isApprovalHolding } from "../services/specialRefundApproval";

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
        // 次の返金手段変更の登録が管理者の承認待ちになるか（POS の確認画面で知らせる）
        paymentOverrideRequiresApproval: merged.requirePaymentOverrideApproval === true,
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
      idempotencyKey,
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
    const keyResolution = resolveSpecialRefundIdempotencyKey(idempotencyKey);
    if (keyResolution.kind === "invalid") {
      return corsJson(
        { ok: false, error: "idempotencyKey is invalid" },
        { status: 400 },
      );
    }
    // 移行期間: キーを送らない古い POS の拡張からも受ける（POS の拡張を先に出し、そのあとサーバーを出す）。
    // main と同じく登録ごとに新しい ID を作り、Shopify の @idempotent にはその ID を使う。
    const idempotentEventId = keyResolution.kind === "keyed" ? keyResolution.eventId : null;
    if (keyResolution.kind === "missing") {
      console.warn("[special-refunds] idempotencyKey missing (old POS extension)", {
        shopId: shop.id,
        eventType: eventTypeStr,
      });
    }

    const idempotencyPayload = {
      shopId: shop.id,
      sourceOrderId: sourceOrderIdStr,
      sourceOrderName: sourceOrderName ? String(sourceOrderName) : null,
      locationId: locationId ? String(locationId) : "",
      eventType: eventTypeStr,
      amount: Number(amount),
      currency: currency ? String(currency) : "JPY",
      originalPaymentMethod: originalPaymentMethod ? String(originalPaymentMethod) : null,
      actualRefundMethod: actualRefundMethod ? String(actualRefundMethod) : null,
      adjustKind: adjustKindStr,
      note: note ? String(note) : null,
      voucherFaceValue: voucherFaceValue != null ? Number(voucherFaceValue) : null,
      voucherAppliedAmount: voucherAppliedAmount != null ? Number(voucherAppliedAmount) : null,
      voucherChangeAmount: voucherChangeAmount != null ? Number(voucherChangeAmount) : null,
      createdBy: createdBy ? String(createdBy) : null,
    };

    const replayResponse = (existing: Parameters<typeof serializeEvent>[0]) => {
      if (!matchesSpecialRefundIdempotencyPayload(existing, idempotencyPayload)) {
        return corsJson(
          { ok: false, error: "idempotencyKey is already used for a different request" },
          { status: 409 },
        );
      }
      return corsJson({
        ok: true,
        event: serializeEvent(existing),
        idempotentReplay: true,
        approvalPending: existing.approvalStatus === "pending",
        correctionRegistration:
          existing.shopifyRefundStatus === "skipped" &&
          existing.shopifyRefundError === CORRECTION_SKIP_REASON,
        shopifyRefund: {
          status: existing.shopifyRefundStatus,
          refundId: existing.shopifyRefundId,
          error: existing.shopifyRefundError,
        },
      });
    };

    let existingIdempotentEvent = idempotentEventId
      ? await prisma.specialRefundEvent.findUnique({ where: { id: idempotentEventId } })
      : null;
    if (
      existingIdempotentEvent &&
      !matchesSpecialRefundIdempotencyPayload(existingIdempotentEvent, idempotencyPayload)
    ) {
      return replayResponse(existingIdempotentEvent);
    }
    if (
      existingIdempotentEvent &&
      !["none", "pending"].includes(existingIdempotentEvent.shopifyRefundStatus)
    ) {
      return replayResponse(existingIdempotentEvent);
    }
    // 承認待ち・却下の登録は POS から進めない（Shopify 返金は管理画面の承認のときに行う）
    if (existingIdempotentEvent && isApprovalHolding(existingIdempotentEvent.approvalStatus)) {
      return replayResponse(existingIdempotentEvent);
    }

    const voidedOnOrder = await countVoidedEventsOnOrder(shop.id, sourceOrderIdStr);
    const isCorrectionRegistration =
      merged.correctionUsesRecordOnly && voidedOnOrder > 0;

    const approvalStatus = initialApprovalStatus(merged, eventTypeStr);

    let idempotentReplay = Boolean(existingIdempotentEvent);
    const event = existingIdempotentEvent ?? await (async () => {
      try {
        return await prisma.specialRefundEvent.create({
          data: {
            ...(idempotentEventId ? { id: idempotentEventId } : {}),
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
            approvalStatus,
          },
        });
      } catch (error: unknown) {
        const code = (error as { code?: string } | null)?.code;
        if (idempotentEventId && code === "P2002") {
          const existing = await prisma.specialRefundEvent.findUnique({
            where: { id: idempotentEventId },
          });
          if (existing) {
            idempotentReplay = true;
            existingIdempotentEvent = existing;
            return existing;
          }
        }
        throw error;
      }
    })();

    if (idempotentReplay) {
      if (!matchesSpecialRefundIdempotencyPayload(event, idempotencyPayload)) {
        return replayResponse(event);
      }
      if (!["none", "pending"].includes(event.shopifyRefundStatus)) {
        return replayResponse(event);
      }
      if (isApprovalHolding(event.approvalStatus)) {
        return replayResponse(event);
      }
    }

    if (event.approvalStatus === "pending") {
      // 承認待ち: Shopify 返金も精算への反映もしない。訂正（記録のみ）かどうかは登録の時点で決めて残す。
      const held = isCorrectionRegistration
        ? await prisma.specialRefundEvent.update({
            where: { id: event.id },
            data: { shopifyRefundStatus: "skipped", shopifyRefundError: CORRECTION_SKIP_REASON },
          })
        : event;
      return corsJson(
        {
          ok: true,
          event: serializeEvent(held),
          approvalPending: true,
          correctionRegistration: isCorrectionRegistration,
          shopifyRefund: {
            status: held.shopifyRefundStatus,
            refundId: held.shopifyRefundId,
            error: held.shopifyRefundError,
          },
        },
        { status: 202 },
      );
    }

    const processedEvent = await applyShopifyRefundToEvent(admin, merged, event, {
      originalPaymentMethod: originalPaymentMethod ? String(originalPaymentMethod) : null,
      actualRefundMethod: actualRefundMethod ? String(actualRefundMethod) : null,
      note: note ? String(note) : null,
      // pending は前回すでに実返金処理へ入ったイベント。後から無効化イベントが
      // 増えても記録専用へ切り替えず、同じ Shopify 冪等キーで完了させる。
      isCorrectionRegistration:
        event.shopifyRefundStatus === "pending" ? false : isCorrectionRegistration,
    });

    if (processedEvent.shopifyRefundStatus === "pending") {
      return corsJson(
        {
          ok: false,
          retryable: true,
          error:
            processedEvent.shopifyRefundError ||
            "Shopify 返金を完了できませんでした。同じ内容でもう一度実行してください。",
          event: serializeEvent(processedEvent),
          shopifyRefund: {
            status: processedEvent.shopifyRefundStatus,
            refundId: processedEvent.shopifyRefundId,
            error: processedEvent.shopifyRefundError,
          },
        },
        { status: 503 },
      );
    }

    await syncAfterSpecialRefundProcessed(admin, shop.id, processedEvent);

    return corsJson(
      {
        ok: true,
        event: serializeEvent(processedEvent),
        correctionRegistration: isCorrectionRegistration,
        shopifyRefund: {
          status: processedEvent.shopifyRefundStatus,
          refundId: processedEvent.shopifyRefundId,
          error: processedEvent.shopifyRefundError,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
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
  approvalStatus: string;
  approvalDecidedAt: Date | null;
  approvalDecidedBy: string | null;
  approvalNote: string | null;
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
    approvalStatus: e.approvalStatus,
    approvalDecidedAt: e.approvalDecidedAt?.toISOString() ?? null,
    approvalDecidedBy: e.approvalDecidedBy,
    approvalNote: e.approvalNote,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}
