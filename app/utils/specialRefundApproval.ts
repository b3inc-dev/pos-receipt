/**
 * 特殊返金「支払方法の付け替え」（payment_method_override）の管理者の承認（要件 §0.3.2・T 決定 2026-11-22）。
 * 設定 requireApprovalForPaymentMethodOverride（初めはオフ）がオンのときだけ、
 * 付け替えは承認待ち（approvalStatus = "pending"）で登録し、管理画面で承認／却下する。
 * 承認待ち・却下は精算・点検・売上サマリーに数えない（どちらも buildSettlementPreview を通るので同じになる）。
 * Shopify への書き込みは足さない（承認しても却下しても Shopify には何もしない）。
 */

/** none: 承認の対象外（設定オフ・別の種別・前からある登録） / pending: 承認待ち / approved / rejected */
export type SpecialRefundApprovalStatus = "none" | "pending" | "approved" | "rejected";

export const APPROVAL_STATUSES: readonly SpecialRefundApprovalStatus[] = [
  "none",
  "pending",
  "approved",
  "rejected",
];

export function normalizeApprovalStatus(v: unknown): SpecialRefundApprovalStatus {
  return APPROVAL_STATUSES.includes(v as SpecialRefundApprovalStatus)
    ? (v as SpecialRefundApprovalStatus)
    : "none";
}

/** 承認が要る種別か（今は支払方法の付け替えだけ） */
export function eventTypeNeedsApproval(
  settings: { requireApprovalForPaymentMethodOverride?: boolean | null },
  eventType: string,
): boolean {
  return (
    eventType === "payment_method_override" &&
    settings.requireApprovalForPaymentMethodOverride === true
  );
}

/** 新しい登録の approvalStatus */
export function initialApprovalStatus(
  settings: { requireApprovalForPaymentMethodOverride?: boolean | null },
  eventType: string,
): SpecialRefundApprovalStatus {
  return eventTypeNeedsApproval(settings, eventType) ? "pending" : "none";
}

/** 精算・売上サマリーに数えるか（承認待ち・却下は数えない） */
export function approvalAllowsSettlement(approvalStatus: unknown): boolean {
  const s = normalizeApprovalStatus(approvalStatus);
  return s !== "pending" && s !== "rejected";
}

export function isAwaitingApproval(e: { status?: string | null; approvalStatus?: unknown }): boolean {
  return (e.status ?? "active") === "active" && normalizeApprovalStatus(e.approvalStatus) === "pending";
}

export type ApprovalDecision = "approve" | "reject";

export type ApprovalDecisionCheck =
  | { ok: true; next: "approved" | "rejected" }
  | { ok: false; code: "NOT_PENDING" | "VOIDED" | "BAD_DECISION"; message: string };

/** 管理画面の承認／却下を受けてよいか */
export function checkApprovalDecision(
  e: { status: string; approvalStatus: unknown },
  decision: unknown,
): ApprovalDecisionCheck {
  if (decision !== "approve" && decision !== "reject") {
    return { ok: false, code: "BAD_DECISION", message: "承認か却下を選んでください。" };
  }
  if (e.status !== "active") {
    return { ok: false, code: "VOIDED", message: "無効化された登録は承認・却下できません。" };
  }
  if (normalizeApprovalStatus(e.approvalStatus) !== "pending") {
    return {
      ok: false,
      code: "NOT_PENDING",
      message: "この登録は承認待ちではありません（ほかの人が先に決めた可能性があります）。画面を読み直してください。",
    };
  }
  return { ok: true, next: decision === "approve" ? "approved" : "rejected" };
}

/** 精算画面・点検の警告に出す承認待ちの一覧 */
export interface AwaitingApprovalSpecialRefund {
  id: string;
  eventType: string;
  amount: number;
  sourceOrderName: string | null;
}

export function awaitingApprovalWarningMessage(items: AwaitingApprovalSpecialRefund[]): string {
  const labels = items
    .map((i) => i.sourceOrderName)
    .filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const head = labels.length > 0 ? `（注文: ${labels.slice(0, 5).join("、")}${labels.length > 5 ? " ほか" : ""}）` : "";
  return `管理者の承認待ちの返金手段変更が ${items.length} 件あります${head}。承認されるまで上の金額に入っていません。`;
}

/**
 * 精算に入る特殊返金を、数えるもの・承認待ち（警告に出す）に分ける。却下はどちらにも入れない。
 * settlementEngine（＝売上サマリー）がこれだけを通して分けるので、両方で同じになる。
 */
export function partitionSpecialRefundEventsByApproval<T extends { approvalStatus?: unknown }>(
  events: T[],
): { counted: T[]; awaitingApproval: T[]; rejected: T[] } {
  const counted: T[] = [];
  const awaitingApproval: T[] = [];
  const rejected: T[] = [];
  for (const e of events) {
    const s = normalizeApprovalStatus(e.approvalStatus);
    if (s === "pending") awaitingApproval.push(e);
    else if (s === "rejected") rejected.push(e);
    else counted.push(e);
  }
  return { counted, awaitingApproval, rejected };
}

/**
 * 承認・却下した人を、管理画面の認証の結果から決める（DB の approvalDecidedBy に残す）。
 * - オンラインのセッション（スタッフに紐づく）なら名前（無ければメール）
 * - そうでなければ App Bridge のセッショントークンの sub（Shopify のユーザー ID）を「shopify_user:<ID>」で
 * - どちらも無い（埋め込みでない・トークンが無い）ときは null
 * 名前を後から読むには read_users が要るので、ここでは ID のまま残す。
 */
export function resolveApprovalDecidedBy(auth: {
  session?: {
    onlineAccessInfo?: {
      associated_user?: { first_name?: string | null; last_name?: string | null; email?: string | null } | null;
    } | null;
  } | null;
  sessionToken?: { sub?: unknown } | null;
}): string | null {
  const u = auth.session?.onlineAccessInfo?.associated_user;
  if (u) {
    const name = [u.last_name, u.first_name].map((v) => String(v ?? "").trim()).filter(Boolean).join(" ");
    if (name) return name.slice(0, 100);
    const email = String(u.email ?? "").trim();
    if (email) return email.slice(0, 100);
  }
  const sub = String(auth.sessionToken?.sub ?? "").trim();
  if (/^\d+$/.test(sub)) return `shopify_user:${sub}`;
  return null;
}

/** 履歴の画面に出す「決めた人」 */
export function approvalDecidedByLabel(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = /^shopify_user:(\d+)$/.exec(s);
  return m ? `ユーザー ID ${m[1]}` : s;
}
