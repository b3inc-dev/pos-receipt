/**
 * アプリ独自印字の一本化（shopify.printing）。
 * 保存済みの order_based / cloudprnt_direct は読み取りのみ。出力経路には使わない。
 * SETTLEMENT / INSPECTION の Shopify 注文は作らない。
 */
import type { SettlementPreviewDTO } from "./settlementEngine.server";
import type { PrintSettings } from "../utils/appSettings.server";

export const UNIFIED_PRINT_MODE = "shopify_printing" as const;
export type UnifiedPrintMode = typeof UNIFIED_PRINT_MODE;

export const LEGACY_PRINT_MODES = ["order_based", "cloudprnt_direct"] as const;
export type LegacyPrintMode = (typeof LEGACY_PRINT_MODES)[number];

export function isLegacyPrintMode(value: string | null | undefined): boolean {
  return LEGACY_PRINT_MODES.includes(String(value ?? "") as LegacyPrintMode);
}

/** 実行時の印字方式。DB の旧値は無視して常に shopify.printing。 */
export function resolveRuntimePrintMode(_stored?: string | null): UnifiedPrintMode {
  return UNIFIED_PRINT_MODE;
}

export function buildSettlementIdempotencyKey(
  shopId: string,
  locationId: string,
  targetDate: string,
): string {
  return `${shopId}:${locationId}:${targetDate}`;
}

export function legacySettlementIdempotencyKeys(
  shopId: string,
  locationId: string,
  targetDate: string,
): string[] {
  return LEGACY_PRINT_MODES.map(
    (mode) => `${shopId}:${locationId}:${targetDate}:${mode}`,
  );
}

/** 新規キー + 旧 printMode 付きキー。再実行で精算行を増やさない。 */
export function allSettlementIdempotencyKeys(
  shopId: string,
  locationId: string,
  targetDate: string,
): string[] {
  return [
    buildSettlementIdempotencyKey(shopId, locationId, targetDate),
    ...legacySettlementIdempotencyKeys(shopId, locationId, targetDate),
  ];
}

export function resolvePaperWidthMm(
  settings: Partial<PrintSettings> | null | undefined,
): 58 | 80 {
  const raw =
    settings?.cloudprntPaperWidth ??
    (settings as { paperWidthMm?: string } | null | undefined)?.paperWidthMm ??
    "80mm";
  return String(raw).includes("58") ? 58 : 80;
}

export function shouldCreateSettlementShopifyOrder(
  _printMode?: string | null,
  _flags?: {
    createSettlementOrderWhenPrinting?: boolean;
    orderBasedCreateSettlementOrderEnabled?: boolean;
    preferPrintingApi?: boolean;
    settlementPrintingApiEnabled?: boolean;
  },
): false {
  return false;
}

export type SettlementRowLike = {
  locationId: string;
  targetDate: string;
  currency?: string | null;
  total: unknown;
  netSales: unknown;
  tax: unknown;
  discounts: unknown;
  vipPointsUsed: unknown;
  refundTotal: unknown;
  orderCount: number;
  refundCount: number;
  itemCount: number;
  voucherChangeAmount: unknown;
  paymentSectionsJson?: string | null;
};

/** 再印字用。保存済み Settlement からプレビューを復元し、ライブ再集計しない。 */
export function settlementRowToPreviewDTO(
  settlement: SettlementRowLike,
  locationName: string,
): SettlementPreviewDTO {
  let parsedUnknown: unknown = [];
  try {
    parsedUnknown = settlement.paymentSectionsJson
      ? JSON.parse(settlement.paymentSectionsJson)
      : [];
  } catch {
    parsedUnknown = [];
  }
  const rawSections = Array.isArray(parsedUnknown)
    ? parsedUnknown
    : Array.isArray((parsedUnknown as { sections?: unknown })?.sections)
      ? ((parsedUnknown as { sections: unknown[] }).sections)
      : [];
  const paymentSections = rawSections.map((s) => {
    const row = (s ?? {}) as Record<string, unknown>;
    return {
      gateway: String(row.gateway ?? row.label ?? ""),
      label: String(row.label ?? row.gateway ?? ""),
      net: Number(row.net ?? 0),
      refund: Number(row.refund ?? 0),
      txCount: Number(row.txCount ?? 0),
      refundCount: Number(row.refundCount ?? 0),
    };
  });

  return {
    locationId: settlement.locationId,
    locationName,
    targetDate: settlement.targetDate,
    currency: settlement.currency ?? "JPY",
    total: Number(settlement.total),
    netSales: Number(settlement.netSales),
    tax: Number(settlement.tax),
    discounts: Number(settlement.discounts),
    vipPointsUsed: Number(settlement.vipPointsUsed),
    refundTotal: Number(settlement.refundTotal),
    orderCount: settlement.orderCount,
    refundCount: settlement.refundCount,
    itemCount: settlement.itemCount,
    voucherChangeAmount: Number(settlement.voucherChangeAmount),
    paymentSections,
    appliedSpecialRefundEvents: [],
    appliedVoucherAdjustments: [],
    loyaltyUsageDisplayLabel: "ポイント利用",
    settlementTxFirstHm: null,
    settlementTxLastHm: null,
    taxShopify: 0,
  };
}

export function displayPrintModeLabel(stored: string | null | undefined): string {
  const runtime = resolveRuntimePrintMode(stored);
  if (runtime === UNIFIED_PRINT_MODE) {
    if (isLegacyPrintMode(stored)) {
      return "Shopify Printing API（保存値は出力に未使用）";
    }
    return "Shopify Printing API";
  }
  return "Shopify Printing API";
}
