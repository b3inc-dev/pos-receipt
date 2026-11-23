/**
 * 特殊返金イベントの精算 overlay（純関数）。
 * shopify_execute 成功後は Shopify TX が正本のため金額加算をスキップし、
 * payment_method_override は親 gateway → 実手段への振替のみ行う。
 * pending（Shopify 返金の成否が分からない）は数えない。精算は assertNoPendingSpecialRefunds で確定を止める。
 */
import { GAS_UNKNOWN_GATEWAY, gasNormalizeGatewayLabel } from "./settlementAggregatePure.server";

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
  /** 警告に出す注文番号（任意） */
  sourceOrderName?: string | null;
}

/** 返金方法が支払方法マスタに無いときに載せる行（集計の「未分類」と同じ行にまとめる） */
export const UNMATCHED_REFUND_SECTION_KEY = GAS_UNKNOWN_GATEWAY;

/**
 * 特殊返金を支払方法の行に載せるときの手がかり（精算エンジンが支払方法マスタから作る）。
 * 渡さなければ今までどおり、見つからない手段はその名前で行を作る。
 */
export interface SpecialRefundOverlayOpts {
  /** 支払方法マスタ（または既定の名前）で分かる手段か */
  isKnownMethod?: (method: string) => boolean;
  /** 新しく行を作るときの表示名 */
  labelForMethod?: (method: string) => string;
  /**
   * 「支払方法マスタで分ける」店だけ渡す。特殊返金の手段（マスタの gateway の名前）を
   * 精算の行の名前（マスタの表示名）に直してから探す。渡さなければ今の探し方。
   */
  resolveKey?: PaymentKeyOf;
}

/** gateway の名前（特殊返金の手段）→ 精算の行の名前（集計キー） */
export type PaymentKeyOf = (gatewayOrLabel: string) => string;

/**
 * 特殊返金のうち、支払方法の行にきちんと載せられなかったもの（精算画面に警告として出す）。
 * - refund_method_not_in_master: 返金方法がマスタに無いので「未分類」の行に載せた（合計は変わらない）
 * - original_method_not_found: Shopify 返金済みだが、元の支払方法の行がその日に無いので付け替えなかった
 * - adjust_method_not_found: レシート調整の支払方法の行がその日に無い（行の金額は動かしていない）
 */
export type UnmatchedRefundMethodReason =
  | "refund_method_not_in_master"
  | "original_method_not_found"
  | "adjust_method_not_found";

export interface UnmatchedRefundMethodWarning {
  reason: UnmatchedRefundMethodReason;
  eventType: string;
  amount: number;
  method: string;
  sourceOrderName: string | null;
}

export function unmatchedRefundWarningMessage(w: UnmatchedRefundMethodWarning): string {
  const order = w.sourceOrderName ? `注文 ${w.sourceOrderName}・` : "";
  const yen = `¥${Math.round(w.amount).toLocaleString("ja-JP")}`;
  switch (w.reason) {
    case "refund_method_not_in_master":
      return `${order}${yen}: 返金方法「${w.method}」が支払方法マスタに無いため「${UNMATCHED_REFUND_SECTION_KEY}」に入れました。支払方法マスタに登録してから更新してください。`;
    case "original_method_not_found":
      return `${order}${yen}: 元の支払方法「${w.method}」の行がこの日に無いため、返金方法変更をしていません。`;
    case "adjust_method_not_found":
      return `${order}${yen}: レシート調整の支払方法「${w.method}」の行がこの日に無いため、支払方法別の金額には入っていません。`;
  }
}

/** payment sections から gateway または label で該当セクションのインデックスを返す */
export function findPaymentSectionIndex(
  sections: OverlayPaymentSection[],
  gatewayOrLabel: string | null,
  resolveKey?: PaymentKeyOf,
): number {
  if (!gatewayOrLabel) return -1;
  const raw = String(gatewayOrLabel).trim();
  if (resolveKey) {
    const key = String(resolveKey(raw) ?? "").trim().toLowerCase();
    if (key) {
      const exact = sections.findIndex(
        (sec) => String(sec.gateway).trim().toLowerCase() === key,
      );
      if (exact >= 0) return exact;
    }
  }
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
  resolveKey?: PaymentKeyOf,
): number {
  let idx = findPaymentSectionIndex(sections, gatewayOrLabel, resolveKey);
  if (idx >= 0) return idx;
  const rawKey = String(gatewayOrLabel).trim() || "cash";
  const key = (resolveKey ? String(resolveKey(rawKey) ?? "").trim() : "") || rawKey;
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
 * 返金を載せる行。その日に行が無ければ作る。
 * マスタで分からない手段は「未分類」の行に載せ、警告を残す（合計は変わらない）。
 */
function ensureRefundSection(
  sections: OverlayPaymentSection[],
  method: string,
  opts: SpecialRefundOverlayOpts | undefined,
  warn: (reason: UnmatchedRefundMethodReason, method: string) => void,
): number {
  const idx = findPaymentSectionIndex(sections, method, opts?.resolveKey);
  if (idx >= 0) return idx;
  const key = String(method).trim() || "cash";
  if (opts?.isKnownMethod && !opts.isKnownMethod(key)) {
    warn("refund_method_not_in_master", key);
    const unknownIdx = findPaymentSectionIndex(sections, UNMATCHED_REFUND_SECTION_KEY);
    if (unknownIdx >= 0) return unknownIdx;
    sections.push({
      gateway: UNMATCHED_REFUND_SECTION_KEY,
      label: UNMATCHED_REFUND_SECTION_KEY,
      net: 0,
      refund: 0,
      txCount: 0,
      refundCount: 0,
    });
    return sections.length - 1;
  }
  if (!opts?.labelForMethod) return ensureSection(sections, key, opts?.resolveKey);
  // マスタで分ける店は、行の名前（gateway）も表示名もマスタの表示名にそろえる
  const resolved = opts.resolveKey ? String(opts.resolveKey(key) ?? "").trim() : "";
  sections.push({
    gateway: resolved || key,
    label: resolved || opts.labelForMethod(key) || key,
    net: 0,
    refund: 0,
    txCount: 0,
    refundCount: 0,
  });
  return sections.length - 1;
}

/**
 * Shopify が計上した元手段から、店頭で実際に払い出した手段へ返金額を移す。
 * 元手段を特定できない場合は二重控除を避けるため何も追加しない（警告は残す）。
 */
function transferExecutedRefund(
  sections: OverlayPaymentSection[],
  originalPaymentMethod: string | null,
  actualRefundMethod: string | null,
  amount: number,
  opts: SpecialRefundOverlayOpts | undefined,
  warn: (reason: UnmatchedRefundMethodReason, method: string) => void,
): void {
  const originalKey = originalPaymentMethod ?? "cash";
  const actualKey = actualRefundMethod ?? "cash";
  const originalIdx = findPaymentSectionIndex(sections, originalKey, opts?.resolveKey);
  if (originalIdx < 0) {
    warn("original_method_not_found", originalKey);
    return;
  }

  const actualIdx = ensureRefundSection(sections, actualKey, opts, warn);
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
      `特殊返金の返金の結果が分かっていない（返金処理中の）ため、集計は確定していません（注文: ${shown}${more}）。` +
        "自動の確定をオンにした店では、返金を試してから数分たつと、アプリが自動で Shopify を読み直して決めます。少し待ってから、もう一度精算してください。" +
        "それでも止まるときは、まず Shopify の管理画面で、この注文に返金があるかを確かめてください。" +
        "そのあと POS の「返金方法変更」タイルでこの注文を開き、「返金処理中」と出ている登録の「返金を確かめる」を押してから、もう一度精算してください（同じ登録のまま確かめるので、返金は 2 回になりません）。" +
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
 * - opts.isKnownMethod を渡すと、マスタに無い返金方法は「未分類」の行に載せる
 * 戻り値: 行にきちんと載せられなかった特殊返金（精算画面の警告用）
 */
export function applySpecialRefundEventsToTotals(
  sections: OverlayPaymentSection[],
  otherEvents: SpecialRefundOverlayEvent[],
  totals: { total: number; refundTotal: number },
  opts?: SpecialRefundOverlayOpts,
): UnmatchedRefundMethodWarning[] {
  const warnings: UnmatchedRefundMethodWarning[] = [];
  for (const e of otherEvents) {
    const amount = Number(e.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const warn = (reason: UnmatchedRefundMethodReason, method: string) => {
      warnings.push({
        reason,
        eventType: e.eventType,
        amount,
        method,
        sourceOrderName: e.sourceOrderName ?? null,
      });
    };
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
            opts,
            warn,
          );
          break;
        }
        totals.refundTotal += amount;
        const idx = ensureRefundSection(sections, e.actualRefundMethod ?? "cash", opts, warn);
        sections[idx].refund += amount;
        break;
      }
      case "receipt_cash_adjustment": {
        if (executed) break;
        const kind = (e.adjustKind ?? "undo").toLowerCase();
        const method = e.originalPaymentMethod ?? e.actualRefundMethod ?? "cash";
        const idx = findPaymentSectionIndex(sections, method, opts?.resolveKey);
        if (idx < 0) warn("adjust_method_not_found", method);
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
            opts,
            warn,
          );
          break;
        }
        totals.refundTotal += amount;
        const idx = ensureRefundSection(sections, e.actualRefundMethod ?? "cash", opts, warn);
        sections[idx].refund += amount;
        break;
      }
      default:
        break;
    }
  }
  return warnings;
}
