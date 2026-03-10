/**
 * GET  /api/special-refunds?sourceOrderId=...
 * POST /api/special-refunds
 * 要件書 21.4: 特殊返金イベント 一覧取得・登録
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";

const ALLOWED_EVENT_TYPES = [
  "cash_refund",
  "payment_method_override",
  "receipt_cash_adjustment",
] as const;

// GET /api/special-refunds?sourceOrderId=...
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

    const url = new URL(request.url);
    const sourceOrderId = url.searchParams.get("sourceOrderId");

    if (!sourceOrderId) {
      return Response.json(
        { ok: false, error: "sourceOrderId is required" },
        { status: 400 }
      );
    }

    const items = await prisma.specialRefundEvent.findMany({
      where: {
        shopId: shop.id,
        sourceOrderId,
        eventType: { in: [...ALLOWED_EVENT_TYPES] },
      },
      orderBy: { createdAt: "desc" },
    });

    return Response.json({ items: items.map(serializeEvent) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

// POST /api/special-refunds
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

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
      adjustKind,
      note,
      createdBy,
    } = body;

    if (!sourceOrderId || !eventType || amount == null) {
      return Response.json(
        { ok: false, error: "sourceOrderId, eventType, amount are required" },
        { status: 400 }
      );
    }
    if (!ALLOWED_EVENT_TYPES.includes(eventType as typeof ALLOWED_EVENT_TYPES[number])) {
      return Response.json(
        { ok: false, error: `eventType must be one of: ${ALLOWED_EVENT_TYPES.join(", ")}` },
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
        adjustKind: adjustKind ? String(adjustKind) : null,
        note: note ? String(note) : null,
        createdBy: createdBy ? String(createdBy) : null,
        status: "active",
      },
    });

    return Response.json({ ok: true, event: serializeEvent(event) }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
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
