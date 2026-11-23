export function fmtYen(amount) {
  const n = Number(amount ?? 0);
  return `¥${n.toLocaleString("ja-JP")}`;
}

export function financialStatusLabel(status, cancelledAt) {
  if (cancelledAt) return "キャンセル";
  const s = String(status || "").toUpperCase();
  if (s === "PAID") return "支払済";
  if (s === "PARTIALLY_REFUNDED") return "一部返金";
  if (s === "REFUNDED") return "返金済";
  if (s === "PENDING") return "保留";
  if (s === "AUTHORIZED") return "承認済";
  return status || "—";
}

/** @param {Record<string, unknown>} item */
export function formatListBadges(item) {
  const b = item?.posBadges ?? {};
  const out = [];
  // Shopify 返金の結果が分かっていない特殊返金がある（この日の精算が止まる）
  if (b.hasPendingShopifyRefund) out.push({ key: "pending", label: "返金処理中", tone: "critical" });
  if (b.cancelled) out.push({ key: "cancelled", label: "キャンセル", tone: "critical" });
  if (b.refundedShopify) out.push({ key: "refund", label: "返金済", tone: "warning" });
  if (b.hasApprovalPending) out.push({ key: "approval", label: "承認待ち", tone: "caution" });
  if (b.hasSpecialRefund || b.appSpecialApplied) out.push({ key: "special", label: "特殊返金 登録済", tone: "info" });
  if (b.hasVoucherAdjustment) out.push({ key: "vadj", label: "商品券 登録済", tone: "success" });
  if (b.onlyVoidedAdjustments) out.push({ key: "voided", label: "登録を無効化", tone: "neutral" });
  if (b.hasVoucherChange) out.push({ key: "vchg", label: "商品券釣有り", tone: "caution" });
  else if (b.voucherLikeGateway) out.push({ key: "voucher", label: "商品券", tone: "neutral" });
  if (b.receiptIssued) out.push({ key: "receipt", label: "領収書", tone: "neutral" });
  return out;
}

// label はボタン（スマホの 3 等分に 1 行で収まる長さ。T 2026-11-23「返金」だけに）。
// noun は 0 件の案内で使う（「返金」の絞り込みはキャンセルの注文も含む）
export const LIST_SEGMENTS = [
  { value: "all", label: "すべて", noun: "すべて" },
  { value: "refunded", label: "返金", noun: "返金・キャンセル" },
  { value: "voucher_change", label: "商品券釣有り", noun: "商品券釣有り" },
];

/** @param {Record<string, unknown>} item @param {string} segment */
export function matchesListSegment(item, segment) {
  if (!segment || segment === "all") return true;
  const f = item.segmentFlags ?? {};
  if (segment === "refunded") return Boolean(f.isCancelled || f.isRefunded);
  if (segment === "voucher_change") return Boolean(f.hasVoucherChange);
  return true;
}
