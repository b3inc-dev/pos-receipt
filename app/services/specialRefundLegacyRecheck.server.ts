/**
 * 前からある（ID が `pos_sr_` で始まらない）特殊返金の登録が pending のまま残ったときに、
 * Shopify の注文の返金を読み直して、`success` か `failed` に決めるための純関数。
 *
 * ここでは **Shopify の返金を実行しない**（refundCreate を呼ばない）。
 * 前からの登録は、main のときの返金に冪等キーも印も付いていないため、
 * もう一度実行すると 2 回返金になるおそれがあるから。読むだけで決める。
 *
 * 返金ノートの形:
 * - main（前から）: `POS Receipt 特殊返金 / <eventType> / <メモ>`
 * - このブランチ以降: `[POS_RECEIPT_EVENT:<登録の ID>] / 特殊返金 / <eventType> / <メモ>`
 *   （キー無しの古い POS から受けた登録も、ID は cuid のまま、この印が付く）
 */
import { refundNoteMatchesEvent } from "./shopifyRefundExecute.server";

/** 登録より少し前に作られた返金も候補に入れる（サーバーと Shopify の時計のずれ） */
const CLOCK_SKEW_MS = 10 * 60 * 1000;

const MARKER_RE = /\[POS_RECEIPT_EVENT:([^\]]+)\]/;
const SPECIAL_REFUND_NOTE_LABELS = new Set(["POS Receipt 特殊返金", "特殊返金"]);

export const POS_SPECIAL_REFUND_EVENT_ID_PREFIX = "pos_sr_";

export type LegacyRecheckEvent = {
  id: string;
  eventType: string;
  amount: number | string | { toString(): string };
  createdAt: Date | string;
};

export type OrderRefundForRecheck = {
  id: string;
  note?: string | null;
  createdAt?: string | null;
  totalRefundedSet?: { shopMoney?: { amount?: string | null } | null } | null;
};

export type RefundCandidate = {
  refundId: string;
  amount: number;
  createdAt: string | null;
  note: string;
  /** ノートの形・種別・金額がこの登録と合う */
  looksLikeThisEvent: boolean;
};

export type LegacyRecheckClassification = {
  /** ノートにこの登録の印がある（これがあれば確実） */
  markerMatches: RefundCandidate[];
  /** ノートの形（特殊返金・種別）と金額・時刻が合う */
  noteMatches: RefundCandidate[];
  /** 登録のあとにできた、ほかの返金（管理画面で手で返金した等）。別の登録に紐づいたものは除く */
  otherCandidates: RefundCandidate[];
};

/** 前からの ID（`pos_sr_` で始まらない）か。`pos_sr_` の登録は同じキーで確かめ直す別の道を使う */
export function isLegacySpecialRefundEventId(id: string | null | undefined): boolean {
  const s = String(id ?? "");
  return s.length > 0 && !s.startsWith(POS_SPECIAL_REFUND_EVENT_ID_PREFIX);
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function cents(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function toCandidate(refund: OrderRefundForRecheck, looksLikeThisEvent: boolean): RefundCandidate {
  const amount = Number(refund.totalRefundedSet?.shopMoney?.amount ?? 0);
  return {
    refundId: refund.id,
    amount: Number.isFinite(amount) ? amount : 0,
    createdAt: refund.createdAt ?? null,
    note: String(refund.note ?? "").slice(0, 200),
    looksLikeThisEvent,
  };
}

export function classifyRefundsForLegacyRecheck(
  event: LegacyRecheckEvent,
  refunds: OrderRefundForRecheck[],
  /** 同じ店の、ほかの登録にもう紐づいている Shopify 返金の ID */
  linkedRefundIds: ReadonlySet<string>,
): LegacyRecheckClassification {
  const eventCreated = toMillis(event.createdAt);
  const eventCents = cents(event.amount?.toString());
  const markerMatches: RefundCandidate[] = [];
  const noteMatches: RefundCandidate[] = [];
  const otherCandidates: RefundCandidate[] = [];

  for (const refund of refunds) {
    if (!refund?.id) continue;
    const note = String(refund.note ?? "");
    if (refundNoteMatchesEvent(note, event.id)) {
      markerMatches.push(toCandidate(refund, true));
      continue;
    }
    if (linkedRefundIds.has(refund.id)) continue;
    // 別の登録の印が付いた返金は、その登録のもの
    const marker = note.match(MARKER_RE);
    if (marker && marker[1] !== event.id) continue;

    const refundCreated = toMillis(refund.createdAt);
    const afterEvent =
      eventCreated == null || refundCreated == null || refundCreated >= eventCreated - CLOCK_SKEW_MS;
    if (!afterEvent) continue;

    const parts = note.split(" / ").map((p) => p.trim());
    const isSpecialRefundNote = parts.some((p) => SPECIAL_REFUND_NOTE_LABELS.has(p));
    const sameType = parts.includes(event.eventType);
    const sameAmount =
      eventCents != null && cents(refund.totalRefundedSet?.shopMoney?.amount) === eventCents;

    if (isSpecialRefundNote && sameType && sameAmount) {
      noteMatches.push(toCandidate(refund, true));
    } else {
      otherCandidates.push(toCandidate(refund, false));
    }
  }
  return { markerMatches, noteMatches, otherCandidates };
}

export type LegacyRecheckRequest = {
  /** 何も無し: 読むだけ（決められるときだけ決める） */
  resolution?: "link" | "no_refund" | null;
  /** resolution = link のとき、店の人が選んだ Shopify 返金 */
  refundId?: string | null;
};

export type LegacyRecheckDecision =
  | { action: "success"; refundId: string; reason: "marker" | "note_match" | "staff_link" }
  | { action: "failed_no_refund" }
  | {
      action: "needs_decision";
      reason: "none_found" | "ambiguous";
      candidates: RefundCandidate[];
    }
  | { action: "reject"; error: string; candidates: RefundCandidate[] };

/**
 * どう決めるか。お金は動かさない（読むだけ・記録を変えるだけ）。
 * - 印が合う返金がある → success
 * - 形・種別・金額が合う返金がちょうど 1 件で、ほかに候補が無い → success
 * - それ以外は店の人に選んでもらう（needs_decision）
 *   - link: 選んだ返金が候補の中にあるときだけ success
 *   - no_refund: この登録らしい返金（印・形が合う）が 1 件も無いときだけ failed（＝ Shopify 返金なし）
 */
export function decideLegacyRecheck(
  c: LegacyRecheckClassification,
  req: LegacyRecheckRequest = {},
): LegacyRecheckDecision {
  const candidates = [...c.noteMatches, ...c.otherCandidates];
  if (c.markerMatches.length > 0) {
    return { action: "success", refundId: c.markerMatches[0].refundId, reason: "marker" };
  }

  if (req.resolution === "link") {
    const chosen = String(req.refundId ?? "").trim();
    if (chosen && candidates.some((x) => x.refundId === chosen)) {
      return { action: "success", refundId: chosen, reason: "staff_link" };
    }
    return {
      action: "reject",
      error: "選んだ Shopify 返金は、この登録の候補にありません。もう一度確かめてください。",
      candidates,
    };
  }

  if (req.resolution === "no_refund") {
    if (c.noteMatches.length > 0) {
      return {
        action: "reject",
        error:
          "Shopify にこの登録らしい返金があります。「返金なし」にはできません。下の返金から選んでください。",
        candidates,
      };
    }
    return { action: "failed_no_refund" };
  }

  if (c.noteMatches.length === 1 && c.otherCandidates.length === 0) {
    return { action: "success", refundId: c.noteMatches[0].refundId, reason: "note_match" };
  }
  return {
    action: "needs_decision",
    reason: candidates.length === 0 ? "none_found" : "ambiguous",
    candidates,
  };
}

export const LEGACY_RECHECK_NO_REFUND_NOTE =
  "確かめ直し: Shopify にこの登録の返金はありませんでした（店の人が確かめて決めた）";
