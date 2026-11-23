/**
 * 返金の予約（DB・Shopify を読む）。決まりは refundReservationPure.ts、docs/REFUND_RESERVATION.md。
 *
 * - 予約: 注文 1 件に、使う前の予約は 1 つまで。予約した日（店のタイムゾーン）が終わると使わない
 * - 当てる: 予約のあとにできた、まだ返金方法を変更していない最初の純正の返金に、createNativeRefundReassign で返金方法変更を作る
 *   （金額は返金額で固定・最後の行は残り・Shopify では返金しない・残りを超えない）
 * - 呼ぶところ: orders/updated の知らせ（その注文に予約があるときだけ）、POS で予約を開いたとき
 */
import prisma from "../db.server";
import { getAppSetting, SPECIAL_REFUND_SETTINGS_KEY, DEFAULT_SPECIAL_REFUND_SETTINGS } from "../utils/appSettings.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { initialApprovalStatus } from "../utils/specialRefundApproval";
import { findSelectableRefundMethod } from "../utils/specialRefundMethodValidation";
import { createNativeRefundReassign, fetchNativeRefundLines } from "./nativeRefundReassign.server";
import { NATIVE_REFUND_SOURCE } from "./nativeRefundReassignPure.server";
import { syncOrderAdjustmentsMetafield } from "./orderAdjustments.server";
import { refreshDailySummaryForAdjustment } from "./orderAdjustmentEdit.server";
import { toOrderGid } from "./orderAdjustmentsPure.server";
import {
  checkExpectedAmount,
  normalizeReservationRows,
  numericOrderId,
  refundOnReservationDay,
  parseReservationRows,
  pickRefundForReservation,
  planReservation,
  reservationEventId,
  reservationExpired,
  type ReservationRow,
} from "./refundReservationPure";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

type ReservationRecord = Awaited<ReturnType<typeof prisma.refundReservation.create>>;

async function loadSpecialRefundSettings(shopId: string) {
  const saved = await getAppSetting<Partial<typeof DEFAULT_SPECIAL_REFUND_SETTINGS>>(shopId, SPECIAL_REFUND_SETTINGS_KEY);
  return { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...(saved ?? {}) };
}

/** 管理画面の「返金の予約」がオンか（初めはオフ） */
export async function refundReservationEnabled(shopId: string): Promise<boolean> {
  return (await loadSpecialRefundSettings(shopId)).refundReservationEnabled === true;
}

/** 注文の id の書き方（gid・数字）どちらでも探す */
function orderIdVariants(sourceOrderId: string): string[] {
  const digits = numericOrderId(sourceOrderId);
  return [...new Set([digits, toOrderGid(digits), String(sourceOrderId).trim()].filter(Boolean))];
}

export function serializeReservation(r: ReservationRecord) {
  return {
    id: r.id,
    sourceOrderId: r.sourceOrderId,
    sourceOrderName: r.sourceOrderName,
    rows: parseReservationRows(r.rowsJson),
    expectedAmount: Number(r.expectedAmount),
    note: r.note,
    status: r.status,
    businessDate: r.businessDate,
    appliedRefundId: r.appliedRefundId,
    appliedEventIds: r.appliedEventIds ? (JSON.parse(r.appliedEventIds) as string[]) : [],
    appliedAt: r.appliedAt?.toISOString() ?? null,
    reviewReason: r.reviewReason,
    createdAt: r.createdAt.toISOString(),
  };
}

export type CreateReservationResult =
  | { ok: true; reservation: ReservationRecord }
  | { ok: false; status: number; code: string; message: string };

export async function createRefundReservation(
  admin: AdminClient,
  shopId: string,
  input: {
    sourceOrderId: string;
    sourceOrderName?: string | null;
    locationId?: string | null;
    rows: unknown;
    expectedAmount: unknown;
    note?: string | null;
    createdBy?: string | null;
  },
): Promise<CreateReservationResult> {
  const settings = await loadSpecialRefundSettings(shopId);
  if (settings.refundReservationEnabled !== true) {
    return {
      ok: false,
      status: 403,
      code: "RESERVATION_DISABLED",
      message: "返金の予約は管理画面の「特殊返金設定」でオフになっています。",
    };
  }
  const orderId = numericOrderId(input.sourceOrderId);
  if (!orderId) return { ok: false, status: 400, code: "INVALID_ORDER", message: "注文が読めませんでした" };
  const check = normalizeReservationRows(input.rows);
  if (!check.ok) return { ok: false, status: 400, code: "INVALID_ROWS", message: check.error };
  const amount = checkExpectedAmount(check.rows, input.expectedAmount);
  if (!amount.ok) return { ok: false, status: 400, code: "INVALID_AMOUNT", message: amount.error };
  // 種類は特殊返金設定でオンのものだけ（返金 = 現金返金、付け替え = 返金方法変更）
  for (const r of check.rows) {
    const on = r.eventType === "cash_refund" ? settings.enableCashRefund : settings.enablePaymentMethodOverride;
    if (!on) {
      return {
        ok: false,
        status: 400,
        code: "EVENT_TYPE_DISABLED",
        message: "選んだ種類は、管理画面の「特殊返金設定」でオフになっています。",
      };
    }
  }

  // 返金方法は支払方法マスタ（有効・特殊返金で選べる）からだけ（D 特殊返金の決まりと同じ）
  const selectable = await prisma.paymentMethodMaster.findMany({
    where: { shopId, enabled: true, selectableForSpecialRefund: true },
    select: { rawGatewayPattern: true, displayLabel: true },
  });
  for (const r of check.rows) {
    if (!findSelectableRefundMethod(r.actualRefundMethod, selectable)) {
      return {
        ok: false,
        status: 400,
        code: "REFUND_METHOD_NOT_IN_MASTER",
        message: "選んだ返金方法が、管理画面の「支払方法」で特殊返金に選べるものにありません。",
      };
    }
  }

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const today = getCalendarDateStringInTimeZone(new Date(), timezone);
  await expireOldReservations(shopId, orderId, today);

  const exists = {
    ok: false as const,
    status: 409,
    code: "RESERVATION_EXISTS",
    message: "この注文には、もう予約があります。直すときは、今の予約をやめてから入れ直してください。",
  };
  let reservation: ReservationRecord | null;
  try {
    reservation = await prisma.$transaction(
    async (tx) => {
      const open = await tx.refundReservation.findFirst({
        where: { shopId, sourceOrderId: { in: orderIdVariants(orderId) }, status: "pending" },
      });
      if (open) return null;
      return tx.refundReservation.create({
        data: {
          shopId,
          sourceOrderId: orderId,
          sourceOrderName: input.sourceOrderName ?? null,
          locationId: String(input.locationId ?? ""),
          rowsJson: JSON.stringify(check.rows),
          expectedAmount: amount.expectedAmount,
          note: input.note ? String(input.note) : null,
          createdBy: input.createdBy ? String(input.createdBy) : null,
          status: "pending",
          businessDate: today,
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
  } catch (err) {
    // P2034: 同じ注文の予約が同時に入った（先に入った方が残る）
    if ((err as { code?: string } | null)?.code === "P2034") return exists;
    throw err;
  }
  if (!reservation) return exists;
  return { ok: true, reservation };
}

export async function cancelRefundReservation(
  shopId: string,
  id: string,
): Promise<{ ok: true; reservation: ReservationRecord } | { ok: false; status: number; message: string }> {
  const r = await prisma.refundReservation.updateMany({
    where: { id, shopId, status: { in: ["pending", "needs_review"] } },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  const row = await prisma.refundReservation.findFirst({ where: { id, shopId } });
  if (!row) return { ok: false, status: 404, message: "予約が見つかりません" };
  if (r.count === 0 && row.status !== "cancelled") {
    return {
      ok: false,
      status: 409,
      message: row.status === "applied" ? "この予約はもう返金に使いました。直すときは調整履歴の「変更」を使ってください。" : "この予約は取り消せません",
    };
  }
  return { ok: true, reservation: row };
}

async function expireOldReservations(shopId: string, orderId: string | null, today: string): Promise<void> {
  const open = await prisma.refundReservation.findMany({
    where: { shopId, status: "pending", ...(orderId ? { sourceOrderId: { in: orderIdVariants(orderId) } } : {}) },
    select: { id: true, businessDate: true },
  });
  const old = open.filter((r) => reservationExpired(r.businessDate, today)).map((r) => r.id);
  if (old.length > 0) {
    await prisma.refundReservation.updateMany({ where: { id: { in: old }, status: "pending" }, data: { status: "expired" } });
  }
}

export async function listRefundReservations(shopId: string, sourceOrderId: string): Promise<ReservationRecord[]> {
  return prisma.refundReservation.findMany({
    where: { shopId, sourceOrderId: { in: orderIdVariants(sourceOrderId) } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/** その注文に、使う前の予約があるか（知らせのたびに Shopify を読まないため） */
export async function hasPendingReservation(shopId: string, sourceOrderId: string): Promise<boolean> {
  const n = await prisma.refundReservation.count({
    where: { shopId, sourceOrderId: { in: orderIdVariants(sourceOrderId) }, status: "pending" },
  });
  return n > 0;
}

export type ApplyResult = { applied: number; review: number; waiting: number; expired: number };

/**
 * 注文の予約を、予約のあとにできた純正の返金に当てる。何回呼んでも同じ（行の id が決まっている・残りを超えない）。
 */
export async function applyRefundReservationsForOrder(
  admin: AdminClient,
  shopId: string,
  sourceOrderId: string,
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, review: 0, waiting: 0, expired: 0 };
  const orderId = numericOrderId(sourceOrderId);
  if (!orderId) return result;
  const variants = orderIdVariants(orderId);
  const pending = await prisma.refundReservation.findMany({
    where: { shopId, sourceOrderId: { in: variants }, status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) return result;
  // オフにした店では当てない（予約は残す。オンに戻したら次の知らせで当てる）
  const settings = await loadSpecialRefundSettings(shopId);
  if (settings.refundReservationEnabled !== true) return result;

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const lines = await fetchNativeRefundLines(admin, orderId);
  const refundDay = (l: { createdAt?: string | null }) =>
    getCalendarDateStringInTimeZone(l.createdAt ? new Date(l.createdAt) : new Date(), timezone);
  const today = getCalendarDateStringInTimeZone(new Date(), timezone);
  const touchedDates = new Set<string>();
  let locationForRefresh = "";

  for (const res of pending) {
    const events = await prisma.specialRefundEvent.findMany({
      where: { shopId, sourceOrderId: { in: variants }, refundSource: NATIVE_REFUND_SOURCE },
      select: { id: true, status: true, approvalStatus: true, shopifyRefundId: true, originalPaymentMethod: true, amount: true },
    });
    // 自分の行がもうできている（前に途中まで当てた）なら、その返金に当て直す
    const ownIds = new Set(parseReservationRows(res.rowsJson).map((_, i) => reservationEventId(res.id, i)));
    const ownRefund = events.find((e) => ownIds.has(e.id))?.shopifyRefundId ?? null;
    const picked = ownRefund
      ? { refundId: ownRefund, lines: lines.filter((l) => l.refundId === ownRefund) }
      : pickRefundForReservation(lines, events.filter((e) => !ownIds.has(e.id)), res.createdAt);

    if (!picked) {
      if (reservationExpired(res.businessDate, today)) {
        await prisma.refundReservation.updateMany({ where: { id: res.id, status: "pending" }, data: { status: "expired" } });
        result.expired += 1;
      } else {
        result.waiting += 1;
      }
      continue;
    }

    // 予約した日のうちの返金だけに当てる（別の日の返金は別のことかもしれない）
    if (!ownRefund && !refundOnReservationDay(refundDay(picked.lines[0]), res.businessDate)) {
      await prisma.refundReservation.updateMany({ where: { id: res.id, status: "pending" }, data: { status: "expired" } });
      result.expired += 1;
      continue;
    }

    const rows: ReservationRow[] = parseReservationRows(res.rowsJson);
    const plan = planReservation(picked.lines, rows, Number(res.expectedAmount) > 0 ? Number(res.expectedAmount) : null);
    if (!plan.ok) {
      await prisma.refundReservation.updateMany({
        where: { id: res.id, status: "pending" },
        data: { status: "needs_review", appliedRefundId: picked.refundId, reviewReason: plan.reason },
      });
      result.review += 1;
      continue;
    }

    const createdIds: string[] = [];
    let failure: string | null = null;
    let retryLater = false;
    // 行の番号は予約の行のまま（元と同じ手段で外した行があっても id がずれない）
    for (const planned of plan.rows) {
      const id = reservationEventId(res.id, planned.index);
      if (events.some((e) => e.id === id)) {
        createdIds.push(id);
        continue;
      }
      try {
        const r = await createNativeRefundReassign(lines, {
          refundId: picked.refundId,
          data: {
            id,
            shopId,
            sourceOrderId: orderId,
            sourceOrderName: res.sourceOrderName,
            locationId: res.locationId,
            eventType: planned.eventType,
            amount: planned.amount,
            currency: "JPY",
            originalPaymentMethod: plan.line.gateway,
            actualRefundMethod: planned.actualRefundMethod,
            adjustKind: null,
            note: res.note ? `返金の予約から: ${res.note}` : "返金の予約から",
            createdBy: res.createdBy,
            status: "active",
            approvalStatus: initialApprovalStatus(settings, planned.eventType),
          },
          countDateOf: refundDay,
        });
        if (r.ok) {
          createdIds.push(r.event.id);
          if (r.event.countDate) touchedDates.add(r.event.countDate);
          locationForRefresh = r.event.locationId;
        } else if (r.code === "CONCURRENT_UPDATE") {
          // 同時の書き込み: 予約は使う前のまま残し、次の知らせ・開いたときに続きを当てる
          retryLater = true;
          break;
        } else {
          failure = r.message;
          break;
        }
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "P2002") {
          createdIds.push(id); // 同時に当てた方が先に作った
          continue;
        }
        throw err;
      }
    }

    if (retryLater) {
      result.waiting += 1;
    } else if (failure) {
      await prisma.refundReservation.updateMany({
        where: { id: res.id, status: "pending" },
        data: {
          status: "needs_review",
          appliedRefundId: picked.refundId,
          appliedEventIds: JSON.stringify(createdIds),
          reviewReason: `自動の返金方法変更が途中で止まりました（${failure}）。「返金方法変更」タイルの一覧から残りの返金方法を変更してください。`,
        },
      });
      result.review += 1;
    } else {
      await prisma.refundReservation.updateMany({
        where: { id: res.id, status: "pending" },
        data: { status: "applied", appliedRefundId: picked.refundId, appliedEventIds: JSON.stringify(createdIds), appliedAt: new Date() },
      });
      result.applied += 1;
    }
  }

  if (touchedDates.size > 0) {
    await syncOrderAdjustmentsMetafield(admin, shopId, orderId);
    for (const d of touchedDates) await refreshDailySummaryForAdjustment(admin, shopId, locationForRefresh, d);
  }
  return result;
}
