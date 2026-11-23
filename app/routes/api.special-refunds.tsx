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
import {
  SPECIAL_REFUND_SETTINGS_KEY,
  DEFAULT_SPECIAL_REFUND_SETTINGS,
  VOUCHER_SETTINGS_KEY,
  DEFAULT_VOUCHER_SETTINGS,
  type VoucherSettings,
} from "../utils/appSettings.server";
import { resolveVoucherSettings, voucherManualAdjustmentAllowed } from "../services/voucherChangePure.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import { syncRefundAggregationMetafieldForOrder } from "../services/refundAggregation.server";
import { setOrderRefundAggregationLocationGid } from "../services/posOrderMetafields.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  executeShopifyRefundForEvent,
  shouldExecuteShopifyRefund,
} from "../services/shopifyRefundExecute.server";
import {
  matchesSpecialRefundIdempotencyPayload,
  resolveSpecialRefundIdempotencyKey,
} from "../services/specialRefundIdempotency.server";
import {
  REFUND_METHOD_NOT_IN_MASTER_CODE,
  eventTypeNeedsRefundMethod,
  findSelectableRefundMethod,
  refundMethodNotInMasterMessage,
} from "../utils/specialRefundMethodValidation";
import { normalizeLocationGid } from "../utils/locationGid";
import { autoResolveStalePendingSpecialRefunds } from "../services/specialRefundAutoResolve.server";
import { isAutoResolvedFailure } from "../services/specialRefundAutoResolvePure.server";
import { initialApprovalStatus } from "../utils/specialRefundApproval";
import { metafieldWrittenOf, syncOrderAdjustmentsMetafield } from "../services/orderAdjustments.server";
import { countDateOf } from "../services/orderAdjustmentsPure.server";
import { loadRefundMethodResolver } from "../utils/paymentMethod.server";
import { createNativeRefundReassign, fetchNativeRefundLines, nativeRefundsForOrder } from "../services/nativeRefundReassign.server";

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

// GET /api/special-refunds?sourceOrderId=...
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const settings = await getAppSetting<typeof DEFAULT_SPECIAL_REFUND_SETTINGS>(shop.id, SPECIAL_REFUND_SETTINGS_KEY);
    const merged = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...settings };
    const voucherSettings = resolveVoucherSettings(
      await getAppSetting<Partial<VoucherSettings>>(shop.id, VOUCHER_SETTINGS_KEY),
      DEFAULT_VOUCHER_SETTINGS,
    );
    const allowedTypes = getAllowedEventTypes(merged);
    // 一覧には登録済みの商品券調整も出す（消す操作のため）。新しく登録できるかは voucherAdjustmentAllowed で返す
    // 版の無い設定は今までどおり押せる
    const voucherAdjustmentAllowed =
      voucherSettings.legacy ||
      (voucherManualAdjustmentAllowed(voucherSettings) && allowedTypes.includes("voucher_change_adjustment"));

    const url = new URL(request.url);
    const sourceOrderId = url.searchParams.get("sourceOrderId");

    if (!sourceOrderId) {
      return corsJson(
        { ok: false, error: "sourceOrderId is required" },
        { status: 400 }
      );
    }

    // 返金処理中のまま数分たった登録は、Shopify を読み直して決めてから返す（読むだけ・返金は作らない）
    try {
      await autoResolveStalePendingSpecialRefunds(
        admin,
        shop.id,
        { sourceOrderId },
        { refreshDailySummary: "background", limit: 10 },
      );
    } catch (e) {
      console.warn("[special-refunds] auto-resolve on list failed", e);
    }

    const items = await prisma.specialRefundEvent.findMany({
      where: {
        shopId: shop.id,
        sourceOrderId,
        // 過去の記録は、その種類を今オフにしていても出す（精算には入っているため）。オン・オフは新しい登録だけに効く
      },
      orderBy: { createdAt: "desc" },
    });

    const [voidedCount, methodResolver, timezone, nativeRefundsResult] = await Promise.all([
      countVoidedEventsOnOrder(shop.id, sourceOrderId),
      loadRefundMethodResolver(shop.id),
      getShopTimezoneForDaily(admin, shop.id),
      // POS 純正の返金（付け替えの候補）。読めなくても一覧は返す（POS は前の入力の形にする）
      nativeRefundsForOrder(admin, shop.id, sourceOrderId).then(
        (lines) => ({ ok: true as const, lines }),
        (e: unknown) => {
          console.warn("[special-refunds] native refunds read failed", e);
          return { ok: false as const, lines: [] };
        },
      ),
    ]);
    // 店の画面に出すため、支払方法は表示名に、時刻は店のタイムゾーンにする（内部の名前・UTC を出さない）
    const dateTimeFmt = new Intl.DateTimeFormat("ja-JP", {
      timeZone: timezone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    return corsJson({
      items: items.map((e) => ({
        ...serializeEvent(e),
        originalPaymentLabel: e.originalPaymentMethod ? methodResolver.labelForMethod(e.originalPaymentMethod) : null,
        actualRefundLabel: e.actualRefundMethod ? methodResolver.labelForMethod(e.actualRefundMethod) : null,
        createdAtLabel: dateTimeFmt.format(e.createdAt),
      })),
      allowedEventTypes: allowedTypes,
      // 純正の返金 1 件・支払方法 1 つずつ。読めなかったときは null
      nativeRefunds: nativeRefundsResult.ok
        ? nativeRefundsResult.lines.map((l) => ({
            refundId: l.refundId,
            gateway: l.gateway,
            label: methodResolver.labelForMethod(l.gateway) || l.formattedGateway || l.gateway,
            amount: l.amount,
            reassigned: l.reassigned,
            remaining: l.remaining,
            createdAtLabel: l.createdAt ? dateTimeFmt.format(new Date(l.createdAt)) : null,
          }))
        : null,
      voucherAdjustmentAllowed,
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
      nativeRefundId,
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

    if (String(eventType) === "voucher_change_adjustment") {
      const voucherSettings = resolveVoucherSettings(
        await getAppSetting<Partial<VoucherSettings>>(shop.id, VOUCHER_SETTINGS_KEY),
        DEFAULT_VOUCHER_SETTINGS,
      );
      if (!voucherManualAdjustmentAllowed(voucherSettings)) {
        return corsJson(
          {
            ok: false,
            code: "VOUCHER_ADJUSTMENT_DISABLED",
            error: "商品券の手動調整は管理画面の商品券設定でオフになっています",
          },
          { status: 403 },
        );
      }
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
        approvalRequired: existing.approvalStatus === "pending",
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
      !canResumeShopifyRefund(existingIdempotentEvent)
    ) {
      return replayResponse(existingIdempotentEvent);
    }

    // 新しい登録だけ: 実際の返金手段は支払方法マスタ（有効・特殊返金で選べる）からだけ受ける。
    // 同じキーの呼び直し（Shopify 返金を確かめる）は、あとでマスタを変えても止めない。
    if (!existingIdempotentEvent && eventTypeNeedsRefundMethod(eventTypeStr)) {
      const selectable = await prisma.paymentMethodMaster.findMany({
        where: { shopId: shop.id, enabled: true, selectableForSpecialRefund: true },
        select: { rawGatewayPattern: true, displayLabel: true },
      });
      if (!findSelectableRefundMethod(actualRefundMethod, selectable)) {
        return corsJson(
          {
            ok: false,
            code: REFUND_METHOD_NOT_IN_MASTER_CODE,
            error: refundMethodNotInMasterMessage(actualRefundMethod),
          },
          { status: 400 },
        );
      }
    }

    // POS 純正の返金の付け替え: 金額は純正の返金の残りまで。Shopify では返金しない（設定に関係なく）
    const nativeRefundIdStr = nativeRefundId ? String(nativeRefundId).trim() : "";
    if (nativeRefundIdStr && !existingIdempotentEvent) {
      if (eventTypeStr !== "cash_refund" && eventTypeStr !== "payment_method_override") {
        return corsJson(
          { ok: false, error: "純正の返金は、返金方法変更だけ登録できます" },
          { status: 400 },
        );
      }
      return registerNativeRefundReassign({
        admin,
        shopId: shop.id,
        corsJson,
        nativeRefundId: nativeRefundIdStr,
        settings: merged,
        idempotentEventId,
        replay: replayResponse,
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
          adjustKind: null,
          note: note ? String(note) : null,
          createdBy: createdBy ? String(createdBy) : null,
          status: "active",
          approvalStatus: initialApprovalStatus(merged, eventTypeStr),
        },
      });
    }

    // 純正の返金がある注文に、返金を選ばずに返金方法変更を登録すると、Shopify で 2 回目の返金になったり
    // 精算で 2 回数えたりする。純正の返金があれば止め、読めなければ登録しない（見直し #106 P2-2）。
    // 「レシートの現金を直す」は返金をしないので、そのまま通す。
    if (
      !existingIdempotentEvent &&
      (eventTypeStr === "cash_refund" || eventTypeStr === "payment_method_override")
    ) {
      let nativeLines: Awaited<ReturnType<typeof fetchNativeRefundLines>>;
      try {
        nativeLines = await fetchNativeRefundLines(admin, sourceOrderIdStr, { shopId: shop.id });
      } catch (e) {
        console.error("[special-refunds] native refunds read failed", e);
        return corsJson(
          {
            ok: false,
            code: "NATIVE_REFUNDS_UNREADABLE",
            error: "注文の返金を読めませんでした。少し待ってから、もう一度お試しください。",
          },
          { status: 503 },
        );
      }
      if (nativeLines.length > 0) {
        return corsJson(
          {
            ok: false,
            code: "NATIVE_REFUND_EXISTS",
            error: "この注文は POS で返金済みです。画面を読み直し、返金を選んで返金方法変更を登録してください。",
          },
          { status: 409 },
        );
      }
    }

    const voidedOnOrder = await countVoidedEventsOnOrder(shop.id, sourceOrderIdStr);
    const isCorrectionRegistration =
      merged.correctionUsesRecordOnly && voidedOnOrder > 0;

    // 数える日（店のタイムゾーン）。登録した日。「変更」で元の日のまま直せるように行に持つ
    const shopTimezone = await getShopTimezoneForDaily(admin, shop.id);
    const countDate = getCalendarDateStringInTimeZone(new Date(), shopTimezone);

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
            // 承認制（設定でオンのときの付け替えだけ）: 承認待ちで登録し、管理画面で承認するまで精算に数えない。
            // Shopify 返金の実行は今までどおり（承認では Shopify に何も書かない）
            approvalStatus: initialApprovalStatus(merged, eventTypeStr),
            countDate,
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
      if (!canResumeShopifyRefund(event)) {
        return replayResponse(event);
      }
    }

    // 自動の確定で failed にした登録を POS が同じキー・同じ内容で送り直した: pending に戻して
    // 同じ冪等キーで返金し直す。戻すのは読んだときと同じ行だけ（同時の送り直しは片方だけが進む）。
    let resumedFromAutoFailure = false;
    if (idempotentReplay && isAutoResolvedFailure(event)) {
      const reopened = await prisma.specialRefundEvent.updateMany({
        where: {
          id: event.id,
          status: "active",
          shopifyRefundStatus: "failed",
          shopifyRefundError: event.shopifyRefundError,
          updatedAt: event.updatedAt,
        },
        data: { shopifyRefundStatus: "pending", shopifyRefundProcessedAt: null },
      });
      if (reopened.count !== 1) {
        const latest = await prisma.specialRefundEvent.findUnique({ where: { id: event.id } });
        return replayResponse(latest ?? event);
      }
      resumedFromAutoFailure = true;
    }

    const processedEvent = await applyShopifyRefundToEvent(admin, merged, event, {
      originalPaymentMethod: originalPaymentMethod ? String(originalPaymentMethod) : null,
      actualRefundMethod: actualRefundMethod ? String(actualRefundMethod) : null,
      note: note ? String(note) : null,
      // pending は前回すでに実返金処理へ入ったイベント。後から無効化イベントが
      // 増えても記録専用へ切り替えず、同じ Shopify 冪等キーで完了させる。
      isCorrectionRegistration:
        event.shopifyRefundStatus === "pending" || resumedFromAutoFailure
          ? false
          : isCorrectionRegistration,
    });

    // 注文メタフィールド pos.adjustments を書き直す（失敗しても登録は取り消さない。行に残して精算で警告）
    const metafieldSync = await syncOrderAdjustmentsMetafield(admin, shop.id, processedEvent.sourceOrderId);

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

    const orderGid = String(sourceOrderId).startsWith("gid://")
      ? String(sourceOrderId)
      : `gid://shopify/Order/${String(sourceOrderId).replace(/\D/g, "")}`;
    try {
      const processingGid = normalizeLocationGid(locationId ? String(locationId) : "");
      if (processingGid) {
        await setOrderRefundAggregationLocationGid(admin, orderGid, processingGid);
      } else {
        await syncRefundAggregationMetafieldForOrder(admin, shop.id, orderGid);
      }
    } catch {
      // メタフィールド同期失敗でもイベント登録は成功させる
    }

    // 売上サマリー（過去実績含む）の整合を保つため、登録日の日次キャッシュを再計算
    const locationGid = normalizeLocationGid(processedEvent.locationId);
    if (locationGid) {
      try {
        const targetDate = countDateOf(processedEvent, shopTimezone);
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
        event: serializeEvent(processedEvent),
        correctionRegistration: isCorrectionRegistration,
        approvalRequired: processedEvent.approvalStatus === "pending",
        metafieldWritten: metafieldWrittenOf(metafieldSync),
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

type CorsJson = (body: unknown, init?: ResponseInit) => Promise<Response>;

/**
 * POS 純正の返金の付け替えを登録する（Shopify には書かない）。
 * 登録は shopifyRefundStatus=success・shopifyRefundId=その返金にするので、精算・売上サマリー・ciara-system は
 * 元の手段から実際の手段へ移すだけになる（返金の合計は変えない）。数える日は純正で返金した日。
 * 返金の計上ロケーションのメタフィールドは書き換えない（純正の返金のときに決まっている）。
 */
async function registerNativeRefundReassign(args: {
  admin: Parameters<typeof fetchNativeRefundLines>[0];
  shopId: string;
  corsJson: CorsJson;
  nativeRefundId: string;
  settings: typeof DEFAULT_SPECIAL_REFUND_SETTINGS;
  idempotentEventId: string | null;
  replay: (existing: Parameters<typeof serializeEvent>[0]) => Promise<Response>;
  data: Parameters<typeof createNativeRefundReassign>[1]["data"];
}): Promise<Response> {
  const { admin, shopId, corsJson, data } = args;
  let lines;
  try {
    lines = await fetchNativeRefundLines(admin, String(data.sourceOrderId), { shopId });
  } catch (e) {
    console.warn("[special-refunds] native refund read failed", e);
    return corsJson(
      { ok: false, error: "Shopify の注文の返金を読めませんでした。少し待って、もう一度押してください。" },
      { status: 503 },
    );
  }
  const shopTimezone = await getShopTimezoneForDaily(admin, shopId);
  let result;
  try {
    result = await createNativeRefundReassign(lines, {
      refundId: args.nativeRefundId,
      data,
      countDateOf: (line) =>
        getCalendarDateStringInTimeZone(line.createdAt ? new Date(line.createdAt) : new Date(), shopTimezone),
    });
  } catch (error: unknown) {
    const code = (error as { code?: string } | null)?.code;
    // 同じキーの登録が同時に先にできた: その登録を返す
    if (args.idempotentEventId && code === "P2002") {
      const existing = await prisma.specialRefundEvent.findUnique({ where: { id: args.idempotentEventId } });
      if (existing) return args.replay(existing);
    }
    throw error;
  }
  if (!result.ok) {
    return corsJson({ ok: false, code: result.code, error: result.message }, { status: result.status });
  }
  const event = result.event;

  const metafieldSync = await syncOrderAdjustmentsMetafield(admin, shopId, event.sourceOrderId);

  const locationGid = normalizeLocationGid(event.locationId);
  if (locationGid) {
    try {
      const loc = await prisma.location.findFirst({
        where: { shopId, shopifyLocationGid: locationGid },
        select: { name: true },
      });
      await computeAndCacheDailySummary(admin, shopId, locationGid, loc?.name ?? "", countDateOf(event, shopTimezone));
    } catch {
      // キャッシュ更新失敗でイベント登録自体は失敗させない
    }
  }

  return corsJson(
    {
      ok: true,
      event: serializeEvent(event),
      nativeRefundReassign: true,
      correctionRegistration: false,
      approvalRequired: event.approvalStatus === "pending",
      metafieldWritten: metafieldWrittenOf(metafieldSync),
      shopifyRefund: {
        status: event.shopifyRefundStatus,
        refundId: event.shopifyRefundId,
        error: event.shopifyRefundError,
      },
    },
    { status: 201 },
  );
}

/** 同じキーの送り直しで Shopify の返金へ進んでよい状態か（まだ / 処理中 / 自動の確定で failed） */
function canResumeShopifyRefund(event: {
  status: string;
  shopifyRefundStatus: string;
  shopifyRefundError: string | null;
}): boolean {
  return ["none", "pending"].includes(event.shopifyRefundStatus) || isAutoResolvedFailure(event);
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
  approvalStatus?: string | null;
  approvalReviewedAt?: Date | null;
  countDate?: string | null;
  replacesEventId?: string | null;
  refundSource?: string | null;
  voidedAt?: Date | null;
  voidReason?: string | null;
  metafieldSyncedAt?: Date | null;
  metafieldSyncError?: string | null;
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
    approvalStatus: e.approvalStatus ?? "none",
    approvalReviewedAt: e.approvalReviewedAt?.toISOString() ?? null,
    countDate: e.countDate ?? null,
    replacesEventId: e.replacesEventId ?? null,
    refundSource: e.refundSource ?? null,
    voidedAt: e.voidedAt?.toISOString() ?? null,
    voidReason: e.voidReason ?? null,
    metafieldWritten: e.metafieldSyncError ? false : e.metafieldSyncedAt ? true : null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}
