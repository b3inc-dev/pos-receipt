/**
 * 特殊返金の承認（返金手段変更）。
 * 店舗ごとの設定 requirePaymentOverrideApproval が ON のとき、POS で登録した返金手段変更は
 * 承認待ち（pending）になる。承認までは Shopify 返金をせず、精算・点検・売上サマリーに数えない。
 * 却下（rejected）も数えない。設定より前の登録・承認の要らない種別は not_required。
 *
 * prisma を読まない純粋な関数だけを置く（試験しやすくするため）。
 */

export type SpecialRefundApprovalStatus = "not_required" | "pending" | "approved" | "rejected";

/** 精算・売上サマリーに数える承認の状態 */
export const COUNTABLE_APPROVAL_STATUSES: readonly SpecialRefundApprovalStatus[] = [
  "not_required",
  "approved",
];

export function isCountableApprovalStatus(status: string | null | undefined): boolean {
  // 列が無かった頃の行・読み取りで抜けた値は今までどおり数える
  if (status == null || status === "") return true;
  return (COUNTABLE_APPROVAL_STATUSES as readonly string[]).includes(status);
}

/** 新しく登録するイベントに承認が要るか */
export function requiresApproval(
  settings: { requirePaymentOverrideApproval?: boolean | null },
  eventType: string,
): boolean {
  return settings.requirePaymentOverrideApproval === true && eventType === "payment_method_override";
}

export function initialApprovalStatus(
  settings: { requirePaymentOverrideApproval?: boolean | null },
  eventType: string,
): SpecialRefundApprovalStatus {
  return requiresApproval(settings, eventType) ? "pending" : "not_required";
}

export type ApprovalDecision = "approve" | "reject";

export type ApprovalTransitionCheck =
  | { ok: true; next: "approved" | "rejected" }
  | { ok: false; reason: string };

/** 承認・却下してよいかを確かめる（決めるのは承認待ちで有効な登録だけ） */
export function checkApprovalTransition(
  event: { status: string; approvalStatus: string | null | undefined },
  decision: ApprovalDecision,
): ApprovalTransitionCheck {
  if (event.status !== "active") {
    return { ok: false, reason: "無効化された登録は承認・却下できません。" };
  }
  if (event.approvalStatus !== "pending") {
    const label =
      event.approvalStatus === "approved"
        ? "承認済み"
        : event.approvalStatus === "rejected"
          ? "却下済み"
          : "承認の要らない登録";
    return { ok: false, reason: `この登録は${label}です。画面を読み直してください。` };
  }
  return { ok: true, next: decision === "approve" ? "approved" : "rejected" };
}

/** POS・管理画面に出す状態の名前 */
export function approvalStatusLabel(status: string | null | undefined): string | null {
  switch (status) {
    case "pending":
      return "承認待ち";
    case "approved":
      return "承認済み";
    case "rejected":
      return "却下";
    default:
      return null;
  }
}

/** POS からの登録の続き（Shopify 返金）を止めておく状態か（承認待ち・却下） */
export function isApprovalHolding(status: string | null | undefined): boolean {
  return status === "pending" || status === "rejected";
}
