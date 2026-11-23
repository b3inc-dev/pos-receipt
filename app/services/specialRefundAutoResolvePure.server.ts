/**
 * 「返金処理中」（shopifyRefundStatus = pending）のまま数分たった特殊返金を、
 * Shopify の注文の返金を **読むだけ** で success / failed に決めるための純関数（T 2026-11-23 4:25）。
 *
 * - Shopify の返金は実行しない（refundCreate を呼ばない）。だから返金が 2 回になることはない。
 * - `pos_sr_` の登録（冪等キーあり）: 返金ノートに `[POS_RECEIPT_EVENT:<登録 ID>]` の印がある返金があれば
 *   success。無ければ failed（Shopify に返金は作られていない）。印は refundCreate と同じ入力で付くので、
 *   印が無い＝この登録の返金は Shopify に無い。
 * - 前からの登録（`pos_sr_` で始まらない）: 印、または「特殊返金」のノート・種別・金額が合う返金が
 *   ちょうど 1 件なら success。それ以外は決めない（店の人が「Shopify 返金を確かめる」で選ぶ。
 *   main のときの返金には印が無く、管理画面で手で返金した分と見分けられないため）。
 * - 「数分たった」は最後に返金を試した時刻（updatedAt）から数える。POS の送り直しで pending に
 *   書き直されると updatedAt が新しくなるので、試している最中のものは決めない。
 */
import {
  classifyRefundsForLegacyRecheck,
  decideLegacyRecheck,
  isLegacySpecialRefundEventId,
  type OrderRefundForRecheck,
} from "./specialRefundLegacyRecheck.server";
import { refundNoteMatchesEvent } from "./shopifyRefundExecute.server";

/** 既定: 最後に試してから 5 分たった pending を決める */
export const DEFAULT_AUTO_RESOLVE_AFTER_MINUTES = 5;
const MIN_AUTO_RESOLVE_AFTER_MINUTES = 2;
const MAX_AUTO_RESOLVE_AFTER_MINUTES = 24 * 60;

/** 1 回に読み直す登録の上限（Shopify の読み取りを抑える） */
export const AUTO_RESOLVE_BATCH_LIMIT = 20;

export const AUTO_RESOLVE_FAILED_NOTE_PREFIX = "自動確認:";

/**
 * 何分たったら決めるか。環境変数 SPECIAL_REFUND_AUTO_RESOLVE_AFTER_MINUTES（2〜1440）で変えられる。
 * 読めない値は既定の 5 分。
 */
export function autoResolveAfterMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SPECIAL_REFUND_AUTO_RESOLVE_AFTER_MINUTES;
  const n = raw != null && raw.trim() !== "" ? Number(raw) : NaN;
  const minutes = Number.isFinite(n)
    ? Math.min(MAX_AUTO_RESOLVE_AFTER_MINUTES, Math.max(MIN_AUTO_RESOLVE_AFTER_MINUTES, n))
    : DEFAULT_AUTO_RESOLVE_AFTER_MINUTES;
  return Math.round(minutes * 60 * 1000);
}

/**
 * 自動の確定は既定でオフ。SPECIAL_REFUND_AUTO_RESOLVE=1 / true / on のときだけ動く
 * （開発ストアで確かめるまで本番はオフで出す。T 2026-11-23）。オフでも店の人の「確かめる」は動く。
 */
export function isAutoResolveDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.SPECIAL_REFUND_AUTO_RESOLVE ?? "").trim().toLowerCase();
  return !(v === "1" || v === "true" || v === "on");
}

export type AutoResolveCandidateEvent = {
  id: string;
  status: string;
  shopifyRefundStatus: string;
  updatedAt: Date | string;
};

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** active・pending で、最後に試してから afterMs 以上たったか */
export function isStalePendingSpecialRefund(
  event: AutoResolveCandidateEvent,
  nowMs: number,
  afterMs: number,
): boolean {
  if (event.status !== "active") return false;
  if (String(event.shopifyRefundStatus ?? "").trim().toLowerCase() !== "pending") return false;
  const updated = toMillis(event.updatedAt);
  if (!Number.isFinite(updated)) return false;
  return nowMs - updated >= afterMs;
}

export type AutoResolveEvent = {
  id: string;
  eventType: string;
  amount: number | string | { toString(): string };
  createdAt: Date | string;
};

export type AutoResolveDecision =
  | { action: "success"; refundId: string; reason: "marker" | "note_match" }
  | { action: "failed"; error: string }
  | { action: "leave"; reason: "legacy_needs_staff" };

export function autoResolveFailedNote(afterMinutes: number): string {
  return (
    `${AUTO_RESOLVE_FAILED_NOTE_PREFIX} ${afterMinutes} 分たっても返金処理中だったため Shopify を読み直しました。` +
    "Shopify にこの登録の返金はありません（Shopify の返金は作られていません）。" +
    "精算では、ほかの Shopify 返金の失敗と同じく、この登録の金額をアプリの記録として数えます。"
  );
}

/**
 * 自動の確定で failed にした登録か（Shopify に返金が無かったので failed にしたもの）。
 * POS の「もう一度実行」で同じキー・同じ内容が送られたら、pending に戻して同じ冪等キーで返金し直してよい
 * （冪等キーが同じなので Shopify の返金は 1 回だけ。T 2026-11-23）。
 */
export function isAutoResolvedFailure(event: {
  status: string;
  shopifyRefundStatus: string;
  shopifyRefundError: string | null;
}): boolean {
  return (
    event.status === "active" &&
    event.shopifyRefundStatus === "failed" &&
    typeof event.shopifyRefundError === "string" &&
    event.shopifyRefundError.startsWith(AUTO_RESOLVE_FAILED_NOTE_PREFIX)
  );
}

/**
 * 読み直した Shopify の返金から、この登録をどう決めるか。お金は動かさない。
 * @param linkedRefundIds 同じ注文のほかの登録にもう紐づいた Shopify 返金の ID（前からの登録の判定だけで使う）
 */
export function decideAutoResolve(
  event: AutoResolveEvent,
  refunds: OrderRefundForRecheck[],
  linkedRefundIds: ReadonlySet<string>,
  afterMinutes: number,
): AutoResolveDecision {
  const marked = refunds.find((r) => r?.id && refundNoteMatchesEvent(r.note, event.id));
  if (marked) return { action: "success", refundId: marked.id, reason: "marker" };

  if (!isLegacySpecialRefundEventId(event.id)) {
    return { action: "failed", error: autoResolveFailedNote(afterMinutes) };
  }

  const classification = classifyRefundsForLegacyRecheck(event, refunds, linkedRefundIds);
  const legacy = decideLegacyRecheck(classification, {});
  if (legacy.action === "success" && (legacy.reason === "marker" || legacy.reason === "note_match")) {
    return { action: "success", refundId: legacy.refundId, reason: legacy.reason };
  }
  return { action: "leave", reason: "legacy_needs_staff" };
}
