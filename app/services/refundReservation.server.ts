/**
 * 返金の予約（DB・Shopify を読む）。決まりは refundReservationPure.ts、docs/REFUND_RESERVATION.md。
 *
 * - 予約: 注文 1 件に、使う前の予約は 1 つまで。予約した日（店のタイムゾーン）が終わると使わない
 * - 当てる: 予約のあとにできた、まだ付け替えていない最初の純正の返金に、createNativeRefundReassign で付け替えを作る
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
  normalizeReservationRows,
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

export function serializeReservation(r: ReservationRecord) {
  return {
    id: r.id,
    sourceOrderId: r.sourceOrderId,
    sourceOrderName: r.sourceOrderName,
    rows: parseReservationRows(r.rowsJson),
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
    note?: string | null;
    createdBy?: string | null;
  },
): Promise<CreateReservationResult> {
  const orderGid = toOrderGid(input.sourceOrderId);
  const check = normalizeReservationRows(input.rows);
  if (!check.ok) return { ok: false, status: 400, code: "INVALID_ROWS", message: check.error };

  // 返す手段は支払方法マスタ（有効・特殊返金で選べる）からだけ（D 特殊返金の決まりと同じ）
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
        message: "選んだ返す手段が、管理画面の「支払方法」で特殊返金に選べる手段にありません。",
      };
    }
  }

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const today = getCalendarDateStringInTimeZone(new Date(), timezone);
  await expireOldReservations(shopId, orderGid, today);

  const reservation = await prisma.$transaction(
    async (tx) => {
      const open = await tx.refundReservation.findFirst({
        where: { shopId, sourceOrderId: orderGid, status: "pending" },
      });
      if (open) return null;
      return tx.refundReservation.create({
        data: {
          shopId,
          sourceOrderId: orderGid,
          sourceOrderName: input.sourceOrderName ?? null,
          locationId: String(input.locationId ?? ""),
          rowsJson: JSON.stringify(check.rows),
          note: input.note ? String(input.note) : null,
          createdBy: input.createdBy ? String(input.createdBy) : null,
          status: "pending",
          businessDate: today,
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
  if (!reservation) {
    return {
      ok: false,
      status: 409,
      code: "RESERVATION_EXISTS",
      message: "この注文には、もう予約があります。直すときは、今の予約を取り消してから入れ直してください。",
    };
  }
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

async function expireOldReservations(shopId: string, orderGid: string | null, today: string): Promise<void> {
  const open = await prisma.refundReservation.findMany({
    where: { shopId, status: "pending", ...(orderGid ? { sourceOrderId: orderGid } : {}) },
    select: { id: true, businessDate: true },
  });
  const old = open.filter((r) => reservationExpired(r.businessDate, today)).map((r) => r.id);
  if (old.length > 0) {
    await prisma.refundReservation.updateMany({ where: { id: { in: old }, status: "pending" }, data: { status: "expired" } });
  }
}

export async function listRefundReservations(shopId: string, sourceOrderId: string): Promise<ReservationRecord[]> {
  return prisma.refundReservation.findMany({
    where: { shopId, sourceOrderId: toOrderGid(sourceOrderId) },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/** その注文に、使う前の予約があるか（知らせのたびに Shopify を読まないため） */
export async function hasPendingReservation(shopId: string, sourceOrderId: string): Promise<boolean> {
  const n = await prisma.refundReservation.count({
    where: { shopId, sourceOrderId: toOrderGid(sourceOrderId), status: "pending" },
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
  const orderGid = toOrderGid(sourceOrderId);
  const pending = await prisma.refundReservation.findMany({
    where: { shopId, sourceOrderId: orderGid, status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) return result;

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const lines = await fetchNativeRefundLines(admin, orderGid);
  const saved = await getAppSetting<Partial<typeof DEFAULT_SPECIAL_REFUND_SETTINGS>>(shopId, SPECIAL_REFUND_SETTINGS_KEY);
  const settings = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...(saved ?? {}) };
  const today = getCalendarDateStringInTimeZone(new Date(), timezone);
  const touchedDates = new Set<string>();
  let locationForRefresh = "";

  for (const res of pending) {
    const events = await prisma.specialRefundEvent.findMany({
      where: { shopId, sourceOrderId: orderGid, refundSource: NATIVE_REFUND_SOURCE },
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

    const rows: ReservationRow[] = parseReservationRows(res.rowsJson);
    const plan = planReservation(picked.lines, rows);
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
            sourceOrderId: orderGid,
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
          countDateOf: (line) =>
            getCalendarDateStringInTimeZone(line.createdAt ? new Date(line.createdAt) : new Date(), timezone),
        });
        if (r.ok) {
          createdIds.push(r.event.id);
          if (r.event.countDate) touchedDates.add(r.event.countDate);
          locationForRefresh = r.event.locationId;
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

    if (failure) {
      await prisma.refundReservation.updateMany({
        where: { id: res.id, status: "pending" },
        data: {
          status: "needs_review",
          appliedRefundId: picked.refundId,
          appliedEventIds: JSON.stringify(createdIds),
          reviewReason: `自動の付け替えが途中で止まりました（${failure}）。返金の一覧から残りを付け替えてください。`,
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
    await syncOrderAdjustmentsMetafield(admin, shopId, orderGid);
    for (const d of touchedDates) await refreshDailySummaryForAdjustment(admin, shopId, locationForRefresh, d);
  }
  return result;
}
