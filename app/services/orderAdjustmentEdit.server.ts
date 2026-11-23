/**
 * 特殊返金・商品券調整の「変更」と「無効化」（POS・管理画面・注文ページで同じ処理を使う）。
 * - 変更: 前の行を無効（voided）にして、replaces 付きの新しい行を足す。Shopify の返金はしない。
 * - どちらも、書いたあとに注文メタフィールド pos.adjustments を書き直し、数える日の売上サマリーを計算し直す。
 * 決まりの中身は orderAdjustmentsPure.server.ts の planAdjustmentEdit。
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "./salesSummaryEngine.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { normalizeLocationGid } from "../utils/locationGid";
import { getAppSetting, SPECIAL_REFUND_SETTINGS_KEY, DEFAULT_SPECIAL_REFUND_SETTINGS } from "../utils/appSettings.server";
import { eventTypeNeedsApproval } from "../utils/specialRefundApproval";
import {
  eventTypeNeedsRefundMethod,
  findSelectableRefundMethod,
  refundMethodNotInMasterMessage,
  REFUND_METHOD_NOT_IN_MASTER_CODE,
} from "../utils/specialRefundMethodValidation";
import { SUPERSEDED_SETTLEMENT_STATUS } from "./settlementConfirmedPure.server";
import { metafieldWrittenOf, syncOrderAdjustmentsMetafield } from "./orderAdjustments.server";
import {
  countDateOf,
  planAdjustmentEdit,
  type AdjustmentEditInput,
} from "./orderAdjustmentsPure.server";

type AdminClient = Parameters<typeof computeAndCacheDailySummary>[0];

/** その日・その店の売上サマリーを計算し直す（失敗しても throw しない） */
export async function refreshDailySummaryForAdjustment(
  admin: AdminClient,
  shopId: string,
  locationId: string,
  targetDate: string,
): Promise<void> {
  const locationGid = normalizeLocationGid(locationId);
  if (!locationGid) return;
  try {
    const loc = await prisma.location.findFirst({
      where: { shopId, shopifyLocationGid: locationGid },
      select: { name: true },
    });
    await computeAndCacheDailySummary(admin, shopId, locationGid, loc?.name ?? "", targetDate);
  } catch (err) {
    console.warn(
      `[order-adjustments] daily summary refresh failed shop=${shopId} date=${targetDate}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** その日・その店の精算がもう確定しているか（点検・置き換え済みは除く） */
export async function isSettlementConfirmedFor(
  shopId: string,
  locationId: string,
  targetDate: string,
): Promise<boolean> {
  const locationGid = normalizeLocationGid(locationId);
  if (!locationGid) return false;
  const locIdRaw = locationGid.replace("gid://shopify/Location/", "");
  const rows = await prisma.settlement.findMany({
    where: {
      shopId,
      locationId: { in: [locationGid, locIdRaw] },
      targetDate,
      status: { in: ["completed", "printed"] },
    },
    select: { periodLabel: true, status: true },
  });
  return rows.some((s: { periodLabel: string | null; status: string }) => !s.periodLabel?.startsWith("点検_") && s.status !== SUPERSEDED_SETTLEMENT_STATUS);
}

export type AdjustmentChangeResult =
  | {
      ok: true;
      eventId: string;
      /** 変更のとき: 新しい行の id */
      newEventId?: string;
      sourceOrderId: string;
      sourceOrderName: string | null;
      warning: string | null;
      /** 数える日の精算がもう確定している（POS の「更新」で再確定が要る） */
      settlementAlreadyConfirmed: boolean;
      /** 確定済みで、再確定が要る日（YYYY-MM-DD）。「今日の分にする」では元の日と今日の両方のことがある */
      confirmedDates: string[];
      /** 書けた true / 書けなかった false / 店の設定で書かない null */
      metafieldWritten: boolean | null;
    }
  | { ok: false; status: number; code: string; message: string };

/**
 * 「変更」。前の行を無効にし、新しい行を足す。二人が同時に押しても 1 回だけ（active のときだけ無効にする）。
 */
export async function editAdjustmentEvent(
  admin: AdminClient,
  shopId: string,
  eventId: string,
  input: AdjustmentEditInput,
): Promise<AdjustmentChangeResult> {
  const old = await prisma.specialRefundEvent.findFirst({ where: { id: eventId, shopId } });
  if (!old) return { ok: false, status: 404, code: "NOT_FOUND", message: "登録が見つかりません。画面を読み直してください。" };

  const settingsRaw = await getAppSetting<Partial<typeof DEFAULT_SPECIAL_REFUND_SETTINGS>>(
    shopId,
    SPECIAL_REFUND_SETTINGS_KEY,
  );
  const settings = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...settingsRaw };

  // 返金手段を変えるときは、支払方法マスタ（有効・特殊返金で選べる）にあるものだけ（#81 と同じ）
  if (
    eventTypeNeedsRefundMethod(old.eventType) &&
    input.actualRefundMethod !== undefined &&
    input.actualRefundMethod !== old.actualRefundMethod
  ) {
    const selectable = await prisma.paymentMethodMaster.findMany({
      where: { shopId, enabled: true, selectableForSpecialRefund: true },
      select: { rawGatewayPattern: true, displayLabel: true },
    });
    if (!findSelectableRefundMethod(input.actualRefundMethod, selectable)) {
      return {
        ok: false,
        status: 400,
        code: REFUND_METHOD_NOT_IN_MASTER_CODE,
        message: refundMethodNotInMasterMessage(input.actualRefundMethod),
      };
    }
  }

  const timeZone = await getShopTimezoneForDaily(admin, shopId);
  const now = new Date();
  // 承認待ちの行を直したら新しい行も承認待ち。承認の対象の種別で、設定がオンなら承認待ち
  const approvalStatusForNew =
    old.approvalStatus === "pending" || eventTypeNeedsApproval(settings, old.eventType) ? "pending" : "none";
  const plan = planAdjustmentEdit(old, input, { timeZone, now, approvalStatusForNew });
  if (!plan.ok) return { ok: false, status: plan.code === "NOT_ACTIVE" ? 409 : 400, code: plan.code, message: plan.message };

  const reason = String(input.reason ?? "").trim();
  let newEventId: string;
  try {
    newEventId = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const voided = await tx.specialRefundEvent.updateMany({
        where: { id: old.id, shopId, status: "active" },
        data: { status: "voided", voidedAt: now, voidedBy: input.by ?? null, voidReason: reason },
      });
      if (voided.count !== 1) throw new Error("NOT_ACTIVE");
      const created = await tx.specialRefundEvent.create({
        data: { shopId, ...plan.create },
        select: { id: true },
      });
      return created.id;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_ACTIVE") {
      return {
        ok: false,
        status: 409,
        code: "NOT_ACTIVE",
        message: "この登録はもう無効です（ほかの人が先に直した可能性があります）。画面を読み直してください。",
      };
    }
    throw err;
  }

  const sync = await syncOrderAdjustmentsMetafield(admin, shopId, old.sourceOrderId);
  const oldDate = countDateOf(old, timeZone);
  const newDate = plan.create.countDate;
  for (const d of new Set([oldDate, newDate])) {
    await refreshDailySummaryForAdjustment(admin, shopId, old.locationId, d);
  }
  const confirmedDates: string[] = [];
  for (const d of new Set([oldDate, newDate])) {
    if (await isSettlementConfirmedFor(shopId, old.locationId, d)) confirmedDates.push(d);
  }

  return {
    ok: true,
    eventId: old.id,
    newEventId,
    sourceOrderId: old.sourceOrderId,
    sourceOrderName: old.sourceOrderName,
    warning: plan.warning,
    settlementAlreadyConfirmed: confirmedDates.length > 0,
    confirmedDates,
    metafieldWritten: metafieldWrittenOf(sync),
  };
}

/** 無効化（わけは任意）。Shopify の返金は取り消さない */
export async function voidAdjustmentEvent(
  admin: AdminClient,
  shopId: string,
  eventId: string,
  input: { reason?: string | null; by?: string | null },
): Promise<AdjustmentChangeResult & { shopifyRefundStatus?: string }> {
  const existing = await prisma.specialRefundEvent.findFirst({ where: { id: eventId, shopId } });
  if (!existing) return { ok: false, status: 404, code: "NOT_FOUND", message: "Event not found" };
  if (existing.status === "voided") return { ok: false, status: 409, code: "ALREADY_VOIDED", message: "Already voided" };

  const now = new Date();
  const updated = await prisma.specialRefundEvent.updateMany({
    where: { id: eventId, shopId, status: "active" },
    data: {
      status: "voided",
      voidedAt: now,
      voidedBy: input.by ? String(input.by) : null,
      voidReason: input.reason ? String(input.reason).trim() || null : null,
    },
  });
  if (updated.count !== 1) return { ok: false, status: 409, code: "ALREADY_VOIDED", message: "Already voided" };

  const sync = await syncOrderAdjustmentsMetafield(admin, shopId, existing.sourceOrderId);
  const timeZone = await getShopTimezoneForDaily(admin, shopId);
  const date = countDateOf(existing, timeZone);
  await refreshDailySummaryForAdjustment(admin, shopId, existing.locationId, date);
  const confirmed = await isSettlementConfirmedFor(shopId, existing.locationId, date);

  let warning: string;
  if (existing.refundSource === "native") {
    warning = "付け替えを無効にしました。純正の返金はそのままで、元の支払方法の返金に戻ります。必要なら、もう一度付け替えてください。";
  } else if (existing.shopifyRefundStatus === "success") {
    warning =
      "Shopify 上の返金は自動では取り消されません。必要な場合は Shopify 管理画面で手動対応してください。直すときは「変更」を使うと、Shopify の返金を引き継いだまま記録だけ直せます。";
  } else if (existing.shopifyRefundStatus === "failed") {
    warning = "Shopify 返金は失敗しています。無効化後、正しい内容で再登録できます。";
  } else {
    warning = "無効化しました。直すときは「変更」を使ってください。";
  }
  return {
    ok: true,
    eventId,
    sourceOrderId: existing.sourceOrderId,
    sourceOrderName: existing.sourceOrderName,
    warning,
    settlementAlreadyConfirmed: confirmed,
    confirmedDates: confirmed ? [date] : [],
    metafieldWritten: metafieldWrittenOf(sync),
    shopifyRefundStatus: existing.shopifyRefundStatus,
  };
}
