/**
 * POST /api/voucher-adjustments
 * 要件書 21.4: 商品券調整イベント登録（eventType = voucher_change_adjustment）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson } from "../utils/posAuth.server";
import prisma from "../db.server";

export async function action({ request }: ActionFunctionArgs) {
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
      },
    });

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
          createdAt: event.createdAt.toISOString(),
        },
      },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
