/**
 * GET  /api/special-refunds?sourceOrderId=...
 * POST /api/special-refunds
 * 要件書 21.4: 特殊返金イベント 一覧取得・登録
 * 設定 §8: 有効なイベント種別は特殊返金設定に従う
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson } from "../utils/posAuth.server";
import prisma from "../db.server";
import { getAppSetting } from "../utils/appSettings.server";
import { SPECIAL_REFUND_SETTINGS_KEY, DEFAULT_SPECIAL_REFUND_SETTINGS } from "../utils/appSettings.server";

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

    return corsJson({ items: items.map(serializeEvent), allowedEventTypes: allowedTypes, uiLabels: { specialRefund: merged.specialRefundUiLabel, voucherAdjustment: merged.voucherAdjustmentUiLabel, cashRefund: merged.cashRefundUiLabel, paymentOverride: merged.paymentOverrideUiLabel } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

// POST /api/special-refunds
export async function action({ request }: ActionFunctionArgs) {
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

    const event = await prisma.specialRefundEvent.create({
      data: {
        shopId: shop.id,
        sourceOrderId: String(sourceOrderId),
        sourceOrderName: sourceOrderName ? String(sourceOrderName) : null,
        locationId: locationId ? String(locationId) : "",
        eventType: String(eventType),
        amount: Number(amount),
        currency: currency ? String(currency) : "JPY",
        originalPaymentMethod: originalPaymentMethod ? String(originalPaymentMethod) : null,
        actualRefundMethod: actualRefundMethod ? String(actualRefundMethod) : null,
        voucherFaceValue: voucherFaceValue != null ? Number(voucherFaceValue) : null,
        voucherAppliedAmount: voucherAppliedAmount != null ? Number(voucherAppliedAmount) : null,
        voucherChangeAmount: voucherChangeAmount != null ? Number(voucherChangeAmount) : null,
        adjustKind: adjustKind ? String(adjustKind) : null,
        note: note ? String(note) : null,
        createdBy: createdBy ? String(createdBy) : null,
        status: "active",
      },
    });

    return corsJson({ ok: true, event: serializeEvent(event) }, { status: 201 });
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
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}
