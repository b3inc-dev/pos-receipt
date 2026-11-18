/**
 * 特殊返金イベントの精算 overlay（純関数）。
 * shopify_execute 成功後は Shopify TX が正本のため金額加算をスキップし、
 * payment_method_override は親 gateway → 実手段への振替のみ行う。
 * pending（Shopify 返金の成否が分からない）は数えない。精算は assertNoPendingSpecialRefunds で確定を止める。
 */
import { gasNormalizeGatewayLabel } from "./settlementAggregatePure.server";

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
  const raw = String(gatewayOrLabel).trim();
  const aliases = new Set([
    raw.toLowerCase(),
    gasNormalizeGatewayLabel(raw).trim().toLowerCase(),
  ]);
  return sections.findIndex((sec) => {
    const sectionAliases = [
      sec.gateway,
      sec.label,
      gasNormalizeGatewayLabel(sec.gateway),
      gasNormalizeGatewayLabel(sec.label),
    ].map((value) => String(value).trim().toLowerCase());
    return sectionAliases.some((value) => aliases.has(value));
  });
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

/**
 * Shopify が計上した元手段から、店頭で実際に払い出した手段へ返金額を移す。
 * 元手段を特定できない場合は二重控除を避けるため何も追加しない。
 */
function transferExecutedRefund(
  sections: OverlayPaymentSection[],
  originalPaymentMethod: string | null,
  actualRefundMethod: string | null,
  amount: number,
): void {
  const originalKey = originalPaymentMethod ?? "cash";
  const actualKey = actualRefundMethod ?? "cash";
  const originalIdx = findPaymentSectionIndex(sections, originalKey);
  if (originalIdx < 0) return;

  const actualIdx = ensureSection(sections, actualKey);
  if (originalIdx === actualIdx) return;

  const moved = Math.min(amount, Math.max(0, sections[originalIdx].refund));
  if (moved <= 0) return;
  sections[originalIdx].refund -= moved;
  sections[actualIdx].refund += moved;

  if (moved === amount && sections[originalIdx].refundCount > 0) {
    sections[originalIdx].refundCount -= 1;
    sections[actualIdx].refundCount += 1;
  }
}

/**
 * Shopify 返金を実行したが、成否がまだ分からない状態か（タイムアウト・一時的な失敗で再試行待ち）。
 * Shopify 側では返金ができている場合もあるし、できていない場合もある。
 */
export function isShopifyRefundPending(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === "pending";
}

export const SPECIAL_REFUND_PENDING_CODE = "SPECIAL_REFUND_PENDING";

/**
 * その日の精算に入る特殊返金に、Shopify 返金の成否が分からないもの（pending）があるとき。
 * 数えると Shopify の返金とアプリの上乗せが二重になり、数えないと返金が抜けうるので、確定しない。
 */
export class SpecialRefundPendingError extends Error {
  readonly code = SPECIAL_REFUND_PENDING_CODE;
  readonly orderLabels: string[];

  constructor(orderLabels: string[]) {
    const shown = orderLabels.slice(0, 5).join("、");
    const more = orderLabels.length > 5 ? ` ほか ${orderLabels.length - 5} 件` : "";
    super(
      `特殊返金の Shopify 返金の結果が分かっていないため、集計は確定していません（注文: ${shown}${more}）。` +
        "まず Shopify の管理画面で、この注文に返金があるかを確かめてください。" +
        "そのあと POS の特殊返金でこの注文を開き、「Shopify 返金の結果が分かっていません」と出ている登録の「Shopify 返金を確かめる」を押してから、もう一度精算してください（同じ登録のまま確かめるので、返金は 2 回になりません）。" +
        "この登録を無効化したり、登録し直したりはしないでください（返金や計上が 2 回になることがあります）。",
    );
    this.name = "SpecialRefundPendingError";
    this.orderLabels = orderLabels;
  }
}

/** 精算に入る特殊返金に pending があれば SpecialRefundPendingError を投げる */
export function assertNoPendingSpecialRefunds(
  events: {
    shopifyRefundStatus?: string | null;
    sourceOrderName?: string | null;
    sourceOrderId?: string | null;
  }[],
): void {
  const labels: string[] = [];
  for (const e of events) {
    if (!isShopifyRefundPending(e.shopifyRefundStatus)) continue;
    const label =
      String(e.sourceOrderName ?? "").trim() ||
      String(e.sourceOrderId ?? "").replace(/^gid:\/\/shopify\/Order\//, "").trim() ||
      "不明";
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length > 0) throw new SpecialRefundPendingError(labels);
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
 * - cash_refund / payment_method_override + success: 親手段→実手段の振替（refundTotal は不変）
 * - receipt_cash_adjustment + success: Shopify TX が正本のためスキップ
 * - pending: 何もしない（Shopify 側の返金があればそれだけが数えられる。二重にしない）
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
    // 成否不明。上乗せも振替もしない（呼び出し側は assertNoPendingSpecialRefunds で確定を止める）
    if (isShopifyRefundPending(e.shopifyRefundStatus)) continue;
    const executed = isShopifyRefundSucceeded(e.shopifyRefundStatus);

    switch (e.eventType) {
      case "cash_refund": {
        if (executed) {
          transferExecutedRefund(
            sections,
            e.originalPaymentMethod,
            e.actualRefundMethod,
            amount,
          );
          break;
        }
        totals.refundTotal += amount;
        const idx = ensureSection(sections, e.actualRefundMethod ?? "cash");
        sections[idx].refund += amount;
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
          transferExecutedRefund(
            sections,
            e.originalPaymentMethod,
            e.actualRefundMethod,
            amount,
          );
          break;
        }
        totals.refundTotal += amount;
        const idx = ensureSection(sections, e.actualRefundMethod ?? "cash");
        sections[idx].refund += amount;
        break;
      }
      default:
        break;
    }
  }
}
