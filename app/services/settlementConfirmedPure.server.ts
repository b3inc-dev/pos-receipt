/**
 * 確定済みの精算（Settlement 行）を守るための純粋関数（Issue #20・T の決定「確定値を守る」2026-11-22）。
 *
 * 確定済みの日は、もう一度「確定」を押しても、再集計しても、集計し直さずに DB の値を返す。
 * Shopify の精算注文も書き換えない。DB の値を POS が受け取る preview と同じ形にするのがこの関数。
 */
import type { SettlementPreviewDTO } from "./settlementEngine.server";

/** 点検レシートの行は periodLabel が「点検_」で始まる（api.settlements.create と同じ判定） */
export function isInspectionSettlementRow(row: { periodLabel?: string | null }): boolean {
  return String(row.periodLabel ?? "").startsWith("点検");
}

/** 確定済みとして扱う status（draft・failed は確定ではない） */
export const CONFIRMED_SETTLEMENT_STATUSES = ["completed", "printed"] as const;

export function isConfirmedSettlementRow(row: {
  periodLabel?: string | null;
  status?: string | null;
}): boolean {
  if (isInspectionSettlementRow(row)) return false;
  return (CONFIRMED_SETTLEMENT_STATUSES as readonly string[]).includes(String(row.status ?? ""));
}

/** DB の locationId は GID のことも数字だけのこともあるので、両方で探す */
export function locationIdVariants(locationId: string): string[] {
  const s = String(locationId).trim();
  const num = s.replace("gid://shopify/Location/", "");
  if (!/^\d+$/.test(num)) return [s];
  return Array.from(new Set([s, num, `gid://shopify/Location/${num}`]));
}

type DecimalLike = number | string | { toString(): string };

export type SettlementRowForPreview = {
  locationId: string;
  targetDate: string;
  currency: string | null;
  total: DecimalLike;
  netSales: DecimalLike;
  tax: DecimalLike;
  discounts: DecimalLike;
  vipPointsUsed: DecimalLike;
  refundTotal: DecimalLike;
  orderCount: number;
  refundCount: number;
  itemCount: number;
  voucherChangeAmount: DecimalLike;
  paymentSectionsJson: string | null;
};

function num(v: DecimalLike): number {
  const n = Number(typeof v === "object" ? v.toString() : v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * paymentSectionsJson（支払方法別の内訳の配列）を読む。
 * 配列でないとき・壊れているときは空にする（api.print.settlement.$id と同じ読み方）。
 */
export function parseSavedPaymentSections(json: string | null): SettlementPreviewDTO["paymentSections"] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((s: Record<string, unknown>) => ({
    gateway: String(s.gateway ?? s.label ?? ""),
    label: String(s.label ?? s.gateway ?? ""),
    net: Number(s.net ?? 0),
    refund: Number(s.refund ?? 0),
    txCount: Number(s.txCount ?? 0),
    refundCount: Number(s.refundCount ?? 0),
  }));
}

/**
 * 確定済みの Settlement 行を preview の形にする。集計し直さないので、
 * 適用した特殊返金・商品券調整の一覧や取引時刻は持っていない（空・null で返す）。
 */
export function settlementRowToPreview(
  row: SettlementRowForPreview,
  locationName: string,
  loyaltyUsageDisplayLabel = "ポイント利用",
): SettlementPreviewDTO {
  return {
    locationId: row.locationId,
    locationName,
    targetDate: row.targetDate,
    currency: row.currency ?? "JPY",
    total: num(row.total),
    netSales: num(row.netSales),
    tax: num(row.tax),
    discounts: num(row.discounts),
    vipPointsUsed: num(row.vipPointsUsed),
    refundTotal: num(row.refundTotal),
    orderCount: row.orderCount,
    refundCount: row.refundCount,
    itemCount: row.itemCount,
    voucherChangeAmount: num(row.voucherChangeAmount),
    paymentSections: parseSavedPaymentSections(row.paymentSectionsJson),
    appliedSpecialRefundEvents: [],
    appliedVoucherAdjustments: [],
    loyaltyUsageDisplayLabel,
    settlementTxFirstHm: null,
    settlementTxLastHm: null,
    taxShopify: 0,
  };
}
