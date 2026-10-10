/**
 * 特殊返金イベントの精算 overlay（純関数）。
 * shopify_execute 成功後は Shopify TX が正本のため金額加算をスキップし、
 * payment_method_override は親 gateway → 実手段への振替のみ行う。
 */

export interface OverlayPaymentSection {
  gateway: string;
  label: string;
  net: number;
  refund: number;
  txCount: number;
  refundCount: number;
}

export interface SpecialRefundOverlayEvent {
  eventType: string;
  amount: number | { toString(): string };
  originalPaymentMethod: string | null;
  actualRefundMethod: string | null;
  adjustKind: string | null;
  /** none | skipped | pending | success | failed */
  shopifyRefundStatus?: string | null;
}

/** payment sections から gateway または label で該当セクションのインデックスを返す */
export function findPaymentSectionIndex(
  sections: OverlayPaymentSection[],
  gatewayOrLabel: string | null,
): number {
  if (!gatewayOrLabel) return -1;
  const s = String(gatewayOrLabel).trim().toLowerCase();
  const i = sections.findIndex(
    (sec) => sec.gateway.toLowerCase() === s || sec.label.toLowerCase() === s,
  );
  if (i >= 0) return i;
  if (["現金", "cash"].some((k) => s.includes(k) || k.includes(s))) {
    return sections.findIndex(
      (sec) => sec.gateway.toLowerCase() === "cash" || sec.label === "現金",
    );
  }
  return -1;
}

function ensureSection(
  sections: OverlayPaymentSection[],
  gatewayOrLabel: string,
): number {
  let idx = findPaymentSectionIndex(sections, gatewayOrLabel);
  if (idx >= 0) return idx;
  const key = String(gatewayOrLabel).trim() || "cash";
  sections.push({
    gateway: key,
    label: key,
    net: 0,
    refund: 0,
    txCount: 0,
    refundCount: 0,
  });
  return sections.length - 1;
}

/** Shopify 実返金が成功済み（または同等）なら overlay 金額加算を避ける */
export function isShopifyRefundSucceeded(
  status: string | null | undefined,
): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "success";
}

/**
 * 特殊返金イベントを total / refundTotal / paymentSections に反映。
 * - shopifyRefundStatus===success: cash_refund / receipt_cash_adjustment はスキップ
 * - payment_method_override + success: 親手段→実手段の振替（refundTotal は不変）
 * - それ以外: 従来どおり純 overlay
 */
export function applySpecialRefundEventsToTotals(
  sections: OverlayPaymentSection[],
  otherEvents: SpecialRefundOverlayEvent[],
  totals: { total: number; refundTotal: number },
): void {
  for (const e of otherEvents) {
    const amount = Number(e.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const executed = isShopifyRefundSucceeded(e.shopifyRefundStatus);

    switch (e.eventType) {
      case "cash_refund": {
        if (executed) break;
        totals.refundTotal += amount;
        const idx = findPaymentSectionIndex(sections, e.actualRefundMethod ?? "cash");
        if (idx >= 0) sections[idx].refund += amount;
        else if (sections.length > 0) sections[0].refund += amount;
        break;
      }
      case "receipt_cash_adjustment": {
        if (executed) break;
        const kind = (e.adjustKind ?? "undo").toLowerCase();
        const method = e.originalPaymentMethod ?? e.actualRefundMethod ?? "cash";
        const idx = findPaymentSectionIndex(sections, method);
        if (kind === "undo") {
          totals.refundTotal -= amount;
          if (idx >= 0) sections[idx].refund = Math.max(0, sections[idx].refund - amount);
        } else {
          totals.total += amount;
          if (idx >= 0) sections[idx].net += amount;
        }
        break;
      }
      case "payment_method_override": {
        if (executed) {
          // Shopify TX は親 gateway に返金済み → 実手段へ振替（合計は変えない）
          const origKey = e.originalPaymentMethod ?? "cash";
          const actualKey = e.actualRefundMethod ?? "cash";
          const origIdx = findPaymentSectionIndex(sections, origKey);
          const actualIdx = ensureSection(sections, actualKey);
          if (origIdx >= 0) {
            sections[origIdx].refund = Math.max(0, sections[origIdx].refund - amount);
          }
          sections[actualIdx].refund += amount;
          break;
        }
        totals.refundTotal += amount;
        const idx = findPaymentSectionIndex(sections, e.actualRefundMethod ?? "cash");
        if (idx >= 0) sections[idx].refund += amount;
        break;
      }
      default:
        break;
    }
  }
}
