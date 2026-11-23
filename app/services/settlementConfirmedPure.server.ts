/**
 * 確定済みの精算（Settlement 行）を守るための純粋関数（Issue #20・T の決定「確定値を守る」2026-11-22）。
 *
 * 確定済みの日は、もう一度「確定」を押しても、再集計しても DB の確定値を返し、
 * Shopify の精算注文も書き換えない。DB の値を POS が受け取る preview と同じ形にする。
 * 確定のあとに数が変わった日は再確定できる（T の決定 2026-11-23 4:20）。比べるのが diffConfirmedVsLive、
 * 前の確定値は SUPERSEDED_SETTLEMENT_STATUS で履歴に残す。
 */
import type { SettlementPreviewDTO } from "./settlementEngine.server";
import { extractLocationNumericId, normalizeLocationGid } from "../utils/locationGid";
import { nonSalesFeeTotalFromSaved } from "./nonSalesFeeLines";

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

/** DB の locationId は GID のことも数字だけのこともあるので、両方で探す（形そろえは locationGid.ts） */
export function locationIdVariants(locationId: string): string[] {
  const raw = String(locationId).trim();
  const gid = normalizeLocationGid(raw);
  const num = extractLocationNumericId(raw);
  if (!gid || !num) return [raw];
  return Array.from(new Set([raw, num, gid]));
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

function normalizeSection(s: Record<string, unknown>): SettlementPreviewDTO["paymentSections"][number] {
  return {
    gateway: String(s.gateway ?? s.label ?? ""),
    label: String(s.label ?? s.gateway ?? ""),
    net: Number(s.net ?? 0),
    refund: Number(s.refund ?? 0),
    txCount: Number(s.txCount ?? 0),
    refundCount: Number(s.refundCount ?? 0),
  };
}

/**
 * paymentSectionsJson（支払方法別の内訳）を読む。2 つの形を読む:
 * - 配列（今の形）
 * - `{ format, snapshot, sections: [...] }`（#22 の発行時スナップショットの形。
 *   #22 の `parsePaymentSectionsJson` と同じ読み方。#22 と合わせるときはそちらに寄せる）
 * 壊れているとき・どちらでもないときは空にする。
 */
export function parseSavedPaymentSections(json: string | null): SettlementPreviewDTO["paymentSections"] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.map((s) => normalizeSection((s ?? {}) as Record<string, unknown>));
  }
  if (raw && typeof raw === "object") {
    const sections = (raw as { sections?: unknown }).sections;
    if (Array.isArray(sections)) {
      return sections.map((s) => normalizeSection((s ?? {}) as Record<string, unknown>));
    }
  }
  return [];
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
  const paymentSections = parseSavedPaymentSections(row.paymentSectionsJson);
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
    paymentSections,
    // 売上に含めない送料等は列が無いので、保存した総売上と支払方法別の合計の差から戻す（印字と同じ）
    nonSalesFeeTotal: nonSalesFeeTotalFromSaved(num(row.total), paymentSections),
    appliedSpecialRefundEvents: [],
    appliedVoucherAdjustments: [],
    loyaltyUsageDisplayLabel,
    settlementTxFirstHm: null,
    settlementTxLastHm: null,
    taxShopify: 0,
  };
}

/** 確定値と今の集計を比べる項目（金額・件数） */
const COMPARED_FIELDS = [
  "total",
  "netSales",
  "tax",
  "discounts",
  "vipPointsUsed",
  "refundTotal",
  "orderCount",
  "refundCount",
  "itemCount",
  "voucherChangeAmount",
] as const;

export type ConfirmedVsLiveDiff = {
  /** 値が違う項目（支払方法別の内訳が違うときは "paymentSections"） */
  changedFields: string[];
};

type ComparablePreview = Pick<
  SettlementPreviewDTO,
  (typeof COMPARED_FIELDS)[number] | "paymentSections"
>;

function sectionKey(s: SettlementPreviewDTO["paymentSections"][number]): string {
  return `${s.gateway}\u0000${s.label}`;
}

/**
 * 確定したあとに数が変わったか（T の決定 2026-11-23 4:20: 変わった日は再確定できる）。
 * 金額は円の整数にそろえて比べる。支払方法別は名前ごとに売上・返金・件数を比べる。
 */
export function diffConfirmedVsLive(
  confirmed: ComparablePreview,
  live: ComparablePreview,
): ConfirmedVsLiveDiff {
  const changedFields: string[] = [];
  for (const f of COMPARED_FIELDS) {
    if (Math.round(Number(confirmed[f])) !== Math.round(Number(live[f]))) changedFields.push(f);
  }
  const a = new Map(confirmed.paymentSections.map((s) => [sectionKey(s), s]));
  const b = new Map(live.paymentSections.map((s) => [sectionKey(s), s]));
  let sectionsChanged = false;
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    const same =
      x &&
      y &&
      Math.round(x.net) === Math.round(y.net) &&
      Math.round(x.refund) === Math.round(y.refund) &&
      x.txCount === y.txCount &&
      x.refundCount === y.refundCount;
    // 両方 0 の行が片方にしか無いのは違いとみなさない
    const bothEmpty =
      (!x || (x.net === 0 && x.refund === 0 && x.txCount === 0 && x.refundCount === 0)) &&
      (!y || (y.net === 0 && y.refund === 0 && y.txCount === 0 && y.refundCount === 0));
    if (!same && !bothEmpty) {
      sectionsChanged = true;
      break;
    }
  }
  if (sectionsChanged) changedFields.push("paymentSections");
  return { changedFields };
}

/** 再確定で前の確定値を残すときの status（履歴に残し、確定済みとしては数えない） */
export const SUPERSEDED_SETTLEMENT_STATUS = "superseded";
