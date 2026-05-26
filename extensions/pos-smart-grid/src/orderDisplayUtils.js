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
  if (b.cancelled) out.push({ key: "cancelled", label: "キャンセル", tone: "critical" });
  if (b.refundedShopify) out.push({ key: "refund", label: "返金", tone: "warning" });
  if (b.hasVoucherAdjustment) out.push({ key: "vadj", label: "釣調整済", tone: "success" });
  if (b.hasSpecialRefund || b.appSpecialApplied) out.push({ key: "special", label: "特殊適用", tone: "info" });
  if (b.hasVoucherChange) out.push({ key: "vchg", label: "釣有り", tone: "attention" });
  else if (b.voucherLikeGateway) out.push({ key: "voucher", label: "商品券", tone: "neutral" });
  if (b.receiptIssued) out.push({ key: "receipt", label: "領収書", tone: "neutral" });
  return out;
}

export const LIST_SEGMENTS = [
  { value: "all", label: "すべて" },
  { value: "refunded", label: "返金・キャンセル" },
  { value: "voucher_change", label: "商品券釣有り" },
];

/** @param {Record<string, unknown>} item @param {string} segment */
export function matchesListSegment(item, segment) {
  if (!segment || segment === "all") return true;
  const f = item.segmentFlags ?? {};
  if (segment === "refunded") return Boolean(f.isCancelled || f.isRefunded);
  if (segment === "voucher_change") return Boolean(f.hasVoucherChange);
  return true;
}
