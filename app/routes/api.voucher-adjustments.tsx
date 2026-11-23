/**
 * GET  /api/voucher-adjustments?sourceOrderId=...  → その注文で商品券で払った額（使った額）
 * POST /api/voucher-adjustments
 * 要件書 21.4: 商品券調整イベント登録（eventType = voucher_change_adjustment）
 *
 * 額面（voucherFaceValue）だけ送ればよい。使った額は注文の取引から出し、お釣り = 額面 − 使った額。
 * 使った額を送ったときはそれを使う（取引が読めないときの手入力・前の POS 拡張）。
 * 数える日は注文の日（店のタイムゾーン）。その日の精算が確定済みなら settlementAlreadyConfirmed を返す。
 * 登録したあと、注文メタフィールド pos.adjustments を書き直す（docs/ORDER_ADJUSTMENTS_METAFIELD.md）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  fetchOrderVoucherApplied,
  syncOrderAdjustmentsMetafield,
} from "../services/orderAdjustments.server";
import { voucherChangeOf } from "../services/orderAdjustmentsPure.server";
import { isSettlementConfirmedFor, refreshDailySummaryForAdjustment } from "../services/orderAdjustmentEdit.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    const sourceOrderId = new URL(request.url).searchParams.get("sourceOrderId");
    if (!sourceOrderId) {
      return corsJson({ ok: false, error: "sourceOrderId is required" }, { status: 400 });
    }
    const info = await fetchOrderVoucherApplied(admin, shop.id, sourceOrderId);
    const applied = info?.applied ?? null;
    return corsJson({
      ok: true,
      voucherAppliedAmount: applied,
      appliedFromOrder: applied != null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
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
      currency,
      note,
      createdBy,
    } = body;

    const face = Number(voucherFaceValue);
    if (!sourceOrderId || voucherFaceValue == null || !Number.isFinite(face) || face <= 0) {
      return corsJson(
        { ok: false, error: "sourceOrderId and voucherFaceValue (> 0) are required" },
        { status: 400 },
      );
    }

    // 使った額: 送られたらそれ（取引が読めないときの手入力・前の POS 拡張）、無ければ注文の取引から
    const manualApplied =
      voucherAppliedAmount != null && voucherAppliedAmount !== "" && Number.isFinite(Number(voucherAppliedAmount))
        ? Number(voucherAppliedAmount)
        : null;
    const orderInfo = await fetchOrderVoucherApplied(admin, shop.id, String(sourceOrderId));
    const applied: number | null = manualApplied ?? orderInfo?.applied ?? null;
    if (applied == null || applied < 0) {
      return corsJson(
        {
          ok: false,
          code: "VOUCHER_APPLIED_UNKNOWN",
          error: "注文の中に商品券の支払いが見つかりませんでした。商品券で払った額を入れてください。",
        },
        { status: 400 },
      );
    }
    // お釣りはいつもサーバーで出す（額面 − 使った額）
    const change = voucherChangeOf(face, applied);

    // 数える日は注文の日（T の決定 2026-11-23）。お釣りはその会計のもので、自動の判定と同じ日に入れて二重に数えない。
    // 注文が読めないときだけ登録した日
    const timezone = await getShopTimezoneForDaily(admin, shop.id);
    const countDate = getCalendarDateStringInTimeZone(
      orderInfo?.orderCreatedAt ? new Date(orderInfo.orderCreatedAt) : new Date(),
      timezone,
    );

    const event = await prisma.specialRefundEvent.create({
      data: {
        shopId: shop.id,
        sourceOrderId: String(sourceOrderId),
        sourceOrderName: sourceOrderName ? String(sourceOrderName) : null,
        locationId: locationId ? String(locationId) : "",
        eventType: "voucher_change_adjustment",
        // amount はお釣り（voucherChangeAmount）を代表値として使う
        amount: change,
        currency: currency ? String(currency) : "JPY",
        voucherFaceValue: face,
        voucherAppliedAmount: applied,
        voucherChangeAmount: change,
        note: note ? String(note) : null,
        createdBy: createdBy ? String(createdBy) : null,
        status: "active",
        shopifyRefundStatus: "skipped",
        countDate,
      },
    });

    const metafieldSync = await syncOrderAdjustmentsMetafield(admin, shop.id, event.sourceOrderId);
    // 売上サマリー（過去実績含む）の整合を保つため、数える日の日次キャッシュを再計算
    await refreshDailySummaryForAdjustment(admin, shop.id, event.locationId, countDate);
    const settlementAlreadyConfirmed = await isSettlementConfirmedFor(shop.id, event.locationId, countDate);

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
          countDate: event.countDate,
          createdAt: event.createdAt.toISOString(),
        },
        appliedFromOrder: manualApplied == null,
        metafieldWritten: metafieldSync.ok,
        settlementAlreadyConfirmed,
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
