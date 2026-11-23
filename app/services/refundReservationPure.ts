/**
 * 返金の予約（純関数）。docs/REFUND_RESERVATION.md
 *
 * 純正で返金する前に「実際の返金方法」を決めておき（分割可・最後の行は残り）、
 * 予約のあとにできた最初の純正の返金に、返金方法変更を自動で作る。
 * 返金方法変更の決まり（金額は純正の返金額で固定・Shopify では返金しない・残りを超えない）は
 * nativeRefundReassignPure.server.ts のまま使う。
 */
import {
  reassignedAmountFor,
  sameGateway,
  type NativeRefundLine,
  type ReassignEventRow,
} from "./nativeRefundReassignPure.server";

export const RESERVATION_EVENT_TYPES = ["cash_refund", "payment_method_override"] as const;
export type ReservationEventType = (typeof RESERVATION_EVENT_TYPES)[number];

export type ReservationRow = {
  actualRefundMethod: string;
  eventType: ReservationEventType;
  /** 最後の行は null（残り全部） */
  amount: number | null;
};

export type ReservationStatus = "pending" | "applied" | "cancelled" | "expired" | "needs_review";

function money(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

export type RowsCheck = { ok: true; rows: ReservationRow[] } | { ok: false; error: string };

/** POS から来た行を確かめる。最後の行の金額は捨てて残りにする */
export function normalizeReservationRows(input: unknown): RowsCheck {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "返金方法を 1 つ以上選んでください" };
  if (input.length > 10) return { ok: false, error: "分けられるのは 10 行までです" };
  const rows: ReservationRow[] = [];
  for (let i = 0; i < input.length; i++) {
    const r = (input[i] ?? {}) as Record<string, unknown>;
    const method = String(r.actualRefundMethod ?? "").trim();
    if (!method) return { ok: false, error: `${i + 1} 行目の返金方法を選んでください` };
    const eventType = String(r.eventType ?? "") as ReservationEventType;
    if (!RESERVATION_EVENT_TYPES.includes(eventType)) {
      return { ok: false, error: `${i + 1} 行目の種類が正しくありません` };
    }
    const isLast = i === input.length - 1;
    let amount: number | null = null;
    if (!isLast) {
      amount = money(r.amount);
      if (!(amount > 0)) return { ok: false, error: `${i + 1} 行目の金額を 0 より大きくしてください` };
    }
    rows.push({ actualRefundMethod: method, eventType, amount });
  }
  return { ok: true, rows };
}

/** 注文の id を数字だけにする（POS・純正の返金の付け替えと同じ形。gid でも数字でも受ける） */
export function numericOrderId(sourceOrderId: string): string {
  return String(sourceOrderId ?? "").trim().replace(/^gid:\/\/shopify\/Order\//, "").replace(/\D/g, "");
}

/** 返す見込みの金額を確かめる。決めた行（最後以外）の合計は、この額より小さくする */
export function checkExpectedAmount(
  rows: ReservationRow[],
  input: unknown,
): { ok: true; expectedAmount: number } | { ok: false; error: string } {
  const expectedAmount = money(input);
  if (!(expectedAmount > 0)) return { ok: false, error: "返金する金額を入れてください" };
  const fixed = rows.slice(0, -1).reduce((s, r) => s + money(r.amount), 0);
  if (!(money(fixed) < expectedAmount)) {
    return {
      ok: false,
      error: `分けた金額の合計（¥${money(fixed).toLocaleString()}）を、返金する金額（¥${expectedAmount.toLocaleString()}）より小さくしてください`,
    };
  }
  return { ok: true, expectedAmount };
}

export function parseReservationRows(json: string | null | undefined): ReservationRow[] {
  try {
    const v = JSON.parse(String(json ?? "[]"));
    const c = normalizeReservationRows(v);
    return c.ok ? c.rows : [];
  } catch {
    return [];
  }
}

/** 予約した日が終わったか（店のタイムゾーンの YYYY-MM-DD どうしで比べる） */
export function reservationExpired(businessDate: string, today: string): boolean {
  return String(today) > String(businessDate);
}

/**
 * 予約に使う純正の返金: 予約のあとにでき、まだ 1 円も返金方法を変更していない返金のうち、いちばん早いもの。
 * 返金 1 件の支払方法ごとの行をまとめて返す。
 */
export function pickRefundForReservation(
  lines: NativeRefundLine[],
  events: ReassignEventRow[],
  reservedAt: Date | string,
): { refundId: string; lines: NativeRefundLine[] } | null {
  const since = new Date(reservedAt).getTime();
  const byRefund = new Map<string, NativeRefundLine[]>();
  for (const l of lines ?? []) {
    const at = l.createdAt ? new Date(l.createdAt).getTime() : NaN;
    if (!Number.isFinite(at) || at < since) continue;
    const list = byRefund.get(l.refundId) ?? [];
    list.push(l);
    byRefund.set(l.refundId, list);
  }
  const candidates = [...byRefund.entries()]
    .filter(([, ls]) => ls.every((l) => reassignedAmountFor(l, events) === 0))
    .sort((a, b) => String(a[1][0].createdAt).localeCompare(String(b[1][0].createdAt)));
  if (candidates.length === 0) return null;
  const [refundId, ls] = candidates[0];
  return { refundId, lines: ls };
}

/** index は予約の何行目か（返金方法変更の行の id に使う） */
export type PlannedRow = ReservationRow & { amount: number; index: number };

export type ReservationPlan =
  | { ok: true; line: NativeRefundLine; rows: PlannedRow[] }
  | { ok: false; reason: string };

/**
 * 予約の行を純正の返金に当てる。金額は返金額で固定。最後の行は残り。
 * 元と同じ手段の行は返金方法変更が要らないので作らない（額は使ったことにする）。
 */
export function planReservation(
  refundLines: NativeRefundLine[],
  rows: ReservationRow[],
  expectedAmount?: number | null,
): ReservationPlan {
  if (refundLines.length !== 1) {
    return { ok: false, reason: "返金が複数の支払方法に分かれていたので、自動では返金方法を変更していません。返金の一覧から返金方法を変更してください。" };
  }
  const line = refundLines[0];
  const total = money(line.amount);
  if (rows.length === 0) return { ok: false, reason: "予約の内容が読めませんでした。返金の一覧から返金方法を変更してください。" };
  // 返金額が予約の金額と違う: 別の返金かもしれないので、自動では返金方法を変更しない（T 2026-11-23）
  if (expectedAmount != null && money(expectedAmount) !== total) {
    return {
      ok: false,
      reason: `返金額（¥${total.toLocaleString()}）が予約の金額（¥${money(expectedAmount).toLocaleString()}）と違ったので、自動では返金方法を変更していません。返金の一覧から返金方法を変更してください。`,
    };
  }
  const fixed = rows.slice(0, -1).reduce((s, r) => s + money(r.amount), 0);
  const last = money(total - fixed);
  if (last < 0) {
    return {
      ok: false,
      reason: `予約の金額（¥${fixed.toLocaleString()}）が返金額（¥${total.toLocaleString()}）より大きいので、自動では返金方法を変更していません。返金の一覧から返金方法を変更してください。`,
    };
  }
  const planned: PlannedRow[] = rows.map((r, i) => ({ ...r, index: i, amount: i === rows.length - 1 ? last : money(r.amount) }));
  return {
    ok: true,
    line,
    rows: planned.filter((r) => r.amount > 0 && !sameGateway(r.actualRefundMethod, line.gateway)),
  };
}

/** 返金した日（店のタイムゾーン）が予約した日と同じか。違えば予約は使わない（期限切れ） */
export function refundOnReservationDay(refundDate: string, businessDate: string): boolean {
  return String(refundDate) === String(businessDate);
}

/** 返金方法変更の行の id（同じ予約・同じ行で 2 回作らない） */
export function reservationEventId(reservationId: string, index: number): string {
  return `pos_rr_${reservationId}_${index}`;
}
