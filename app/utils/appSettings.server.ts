/**
 * アプリ設定（AppSetting）の読み書き
 * 要件 §13.1: app_settings は shop 単位の key-value
 */
import prisma from "../db.server";

export async function getAppSetting<T = unknown>(
  shopId: string,
  key: string
): Promise<T | null> {
  const row = await prisma.appSetting.findUnique({
    where: { shopId_key: { shopId, key } },
  });
  if (!row?.valueJson) return null;
  try {
    return JSON.parse(row.valueJson) as T;
  } catch {
    return null;
  }
}

export async function setAppSetting(
  shopId: string,
  key: string,
  valueJson: unknown
): Promise<void> {
  const json = typeof valueJson === "string" ? valueJson : JSON.stringify(valueJson);
  await prisma.appSetting.upsert({
    where: { shopId_key: { shopId, key } },
    update: { valueJson: json, updatedAt: new Date() },
    create: { shopId, key, valueJson: json },
  });
}

// ── 売上サマリー設定（要件 §10） ─────────────────────────────────────────────

export const SALES_SUMMARY_SETTINGS_KEY = "sales_summary_settings";

export interface SalesSummarySettings {
  salesSummaryEnabled: boolean;
  allowSingleDateSummary: boolean;
  allowDateRangeSummary: boolean;
  showLocationRows: boolean;
  showStoreTotals: boolean;
  showOverallTotals: boolean;
  visibleLocationIds: string[];
  showBudget: boolean;
  showActual: boolean;
  showBudgetRatio: boolean;
  showOrders: boolean;
  showVisitors: boolean;
  showConv: boolean;
  showAtv: boolean;
  showSetRate: boolean;
  showItems: boolean;
  showUnitPrice: boolean;
  showMonthBudget: boolean;
  showMonthActual: boolean;
  showMonthAchvRatio: boolean;
  showProgressToday: boolean;
  showProgressPrev: boolean;
  showLoyaltyUsage: boolean;
  loyaltyUsageSummaryLabel: string;
  footfallReportingEnabled: boolean;
  footfallTargetLocationIds: string[];
  footfallReportEditableAfterSubmit: boolean;
  footfallReportRequiresConfirmation: boolean;
}

export const DEFAULT_SALES_SUMMARY_SETTINGS: SalesSummarySettings = {
  salesSummaryEnabled: true,
  allowSingleDateSummary: true,
  allowDateRangeSummary: true,
  showLocationRows: true,
  showStoreTotals: true,
  showOverallTotals: true,
  visibleLocationIds: [],
  showBudget: true,
  showActual: true,
  showBudgetRatio: true,
  showOrders: true,
  showVisitors: true,
  showConv: true,
  showAtv: true,
  showSetRate: true,
  showItems: true,
  showUnitPrice: true,
  showMonthBudget: true,
  showMonthActual: true,
  showMonthAchvRatio: true,
  showProgressToday: true,
  showProgressPrev: true,
  showLoyaltyUsage: true,
  loyaltyUsageSummaryLabel: "ポイント利用額",
  footfallReportingEnabled: true,
  footfallTargetLocationIds: [],
  footfallReportEditableAfterSubmit: false,
  footfallReportRequiresConfirmation: true,
};

// ── ポイント/会員施策設定（要件 §9A） ───────────────────────────────────────

export const LOYALTY_SETTINGS_KEY = "loyalty_settings";

export type LoyaltyUsageSourceType =
  | "discount_code_prefix"
  | "order_metafield"
  | "order_attribute"
  | "custom_app_event"
  | "manual_off";

export interface LoyaltySettings {
  loyaltyUsageFeatureEnabled: boolean;
  loyaltyUsageDisplayLabel: string;
  loyaltyUsageSourceType: LoyaltyUsageSourceType;
  loyaltyUsageSourceConfigJson: string;
  loyaltyUsageDiscountCodePrefixes: string[];
  loyaltyUsageOrderMetafieldNamespace: string | null;
  loyaltyUsageOrderMetafieldKey: string | null;
  loyaltyUsageOrderAttributeKey: string | null;
  loyaltyUsageIncludeInSummary: boolean;
  loyaltyUsageIncludeInSettlement: boolean;
}

export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = {
  loyaltyUsageFeatureEnabled: false,
  loyaltyUsageDisplayLabel: "ポイント利用額",
  loyaltyUsageSourceType: "manual_off",
  loyaltyUsageSourceConfigJson: "{}",
  loyaltyUsageDiscountCodePrefixes: [],
  loyaltyUsageOrderMetafieldNamespace: null,
  loyaltyUsageOrderMetafieldKey: null,
  loyaltyUsageOrderAttributeKey: null,
  loyaltyUsageIncludeInSummary: true,
  loyaltyUsageIncludeInSettlement: true,
};

// ── 商品券設定（要件 §7） ─────────────────────────────────────────────────────

export const VOUCHER_SETTINGS_KEY = "voucher_settings";

export interface VoucherSettings {
  voucherFeatureEnabled: boolean;
  voucherAutoDetectionEnabled: boolean;
  voucherManualAdjustmentEnabled: boolean;
  voucherNoteParseEnabled: boolean;
  voucherNoteParseRegex: string;
  voucherDefaultLabel: string;
  voucherAdjustmentPriority: "manual_first" | "auto_first";
  reflectVoucherChangeInSettlement: boolean;
  reflectVoucherChangeInReceiptDisplay: boolean;
  voucherChangeDisplayLabel: string;
}

export const DEFAULT_VOUCHER_SETTINGS: VoucherSettings = {
  voucherFeatureEnabled: true,
  voucherAutoDetectionEnabled: true,
  voucherManualAdjustmentEnabled: true,
  voucherNoteParseEnabled: false,
  voucherNoteParseRegex: "",
  voucherDefaultLabel: "商品券",
  voucherAdjustmentPriority: "manual_first",
  reflectVoucherChangeInSettlement: true,
  reflectVoucherChangeInReceiptDisplay: true,
  voucherChangeDisplayLabel: "商品券おつり",
};

// ── 特殊返金設定（要件 §8） ───────────────────────────────────────────────────

export const SPECIAL_REFUND_SETTINGS_KEY = "special_refund_settings";

export interface SpecialRefundSettings {
  enableCashRefund: boolean;
  enablePaymentMethodOverride: boolean;
  enableVoucherChangeAdjustment: boolean;
  enableReceiptCashAdjustment: boolean;
  requireOriginalPaymentMethodForPaymentOverride: boolean;
  requireActualRefundMethodForPaymentOverride: boolean;
  requireNoteForCashRefund: boolean;
  requireVoucherFaceValueForVoucherChangeAdjustment: boolean;
  requireVoucherAppliedAmountForVoucherChangeAdjustment: boolean;
  requireVoucherChangeAmountForVoucherChangeAdjustment: boolean;
  reflectCashRefundToSettlement: boolean;
  reflectPaymentOverrideToSettlement: boolean;
  reflectVoucherAdjustmentToSettlement: boolean;
  reflectReceiptCashAdjustmentToSettlement: boolean;
  specialRefundUiLabel: string;
  voucherAdjustmentUiLabel: string;
  cashRefundUiLabel: string;
  paymentOverrideUiLabel: string;
}

export const DEFAULT_SPECIAL_REFUND_SETTINGS: SpecialRefundSettings = {
  enableCashRefund: true,
  enablePaymentMethodOverride: true,
  enableVoucherChangeAdjustment: true,
  enableReceiptCashAdjustment: true,
  requireOriginalPaymentMethodForPaymentOverride: true,
  requireActualRefundMethodForPaymentOverride: true,
  requireNoteForCashRefund: false,
  requireVoucherFaceValueForVoucherChangeAdjustment: true,
  requireVoucherAppliedAmountForVoucherChangeAdjustment: true,
  requireVoucherChangeAmountForVoucherChangeAdjustment: true,
  reflectCashRefundToSettlement: true,
  reflectPaymentOverrideToSettlement: true,
  reflectVoucherAdjustmentToSettlement: true,
  reflectReceiptCashAdjustmentToSettlement: true,
  specialRefundUiLabel: "特殊返金",
  voucherAdjustmentUiLabel: "商品券調整",
  cashRefundUiLabel: "現金返金",
  paymentOverrideUiLabel: "返金手段変更",
};

// ── 一般設定（要件 §3） ───────────────────────────────────────────────────────

export const GENERAL_SETTINGS_KEY = "general_settings";

export interface GeneralSettings {
  appDisplayName: string;
  supportContactEmail: string;
  defaultTimezone: string;
  defaultCurrency: string;
  currentPlanCode: string;
  enabledFeaturesJson: string;
  adminLanguage: string;
  posLanguage: string;
  debugModeEnabled: boolean;
  diagnosticsPanelEnabled: boolean;
  verboseCalcLogEnabled: boolean;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  appDisplayName: "",
  supportContactEmail: "",
  defaultTimezone: "Asia/Tokyo",
  defaultCurrency: "JPY",
  currentPlanCode: "standard",
  enabledFeaturesJson: "{}",
  adminLanguage: "ja",
  posLanguage: "ja",
  debugModeEnabled: false,
  diagnosticsPanelEnabled: true,
  verboseCalcLogEnabled: false,
};

// ── 精算設定（要件 §5） ───────────────────────────────────────────────────────

export const SETTLEMENT_SETTINGS_KEY = "settlement_settings";

export interface SettlementSettings {
  settlementReceiptTitle: string;
  inspectionReceiptTitle: string;
  defaultSettlementNote: string;
  defaultInspectionNote: string;
  showTotal: boolean;
  showNetSales: boolean;
  showTax: boolean;
  showDiscounts: boolean;
  showLoyaltyUsage: boolean;
  showOrderCount: boolean;
  showRefundCount: boolean;
  showItemCount: boolean;
  showPaymentSections: boolean;
  showVoucherChange: boolean;
  showAsOf: boolean;
  showPeriodLabel: boolean;
  showLocationLabel: boolean;
  labelTotal: string;
  labelNetSales: string;
  labelTax: string;
  labelDiscounts: string;
  labelLoyaltyUsage: string;
  labelOrderCount: string;
  labelRefundCount: string;
  labelItemCount: string;
  labelVoucherChange: string;
  settlementFieldOrderJson: string;
  paymentSectionOrderJson: string;
  taxDisplayMode: "inclusive_only" | "inclusive_and_audit";
  taxRoundingMode: "round" | "floor" | "ceil";
  allowRecalculateLatestSettlement: boolean;
  allowReprintSettlement: boolean;
  allowManualTargetDate: boolean;
  orderBasedCreateSettlementOrderEnabled: boolean;
  orderBasedAttachMetafieldsEnabled: boolean;
  orderBasedAttachNoteEnabled: boolean;
}

export const DEFAULT_SETTLEMENT_SETTINGS: SettlementSettings = {
  settlementReceiptTitle: "精算レシート",
  inspectionReceiptTitle: "点検レシート",
  defaultSettlementNote: "",
  defaultInspectionNote: "",
  showTotal: true,
  showNetSales: true,
  showTax: true,
  showDiscounts: true,
  showLoyaltyUsage: true,
  showOrderCount: true,
  showRefundCount: true,
  showItemCount: true,
  showPaymentSections: true,
  showVoucherChange: true,
  showAsOf: true,
  showPeriodLabel: true,
  showLocationLabel: true,
  labelTotal: "合計",
  labelNetSales: "売上",
  labelTax: "税",
  labelDiscounts: "値引",
  labelLoyaltyUsage: "ポイント利用額",
  labelOrderCount: "注文数",
  labelRefundCount: "返品数",
  labelItemCount: "商品数",
  labelVoucherChange: "商品券おつり",
  settlementFieldOrderJson: "[]",
  paymentSectionOrderJson: "[]",
  taxDisplayMode: "inclusive_only",
  taxRoundingMode: "round",
  allowRecalculateLatestSettlement: true,
  allowReprintSettlement: true,
  allowManualTargetDate: true,
  orderBasedCreateSettlementOrderEnabled: true,
  orderBasedAttachMetafieldsEnabled: true,
  orderBasedAttachNoteEnabled: true,
};

// ── 印字設定（要件 §12） ──────────────────────────────────────────────────────

export const PRINT_SETTINGS_KEY = "print_settings";

export interface PrintSettings {
  defaultPrintMode: "cloudprnt_direct" | "order_based";
  locationPrintModeOverrideEnabled: boolean;
  cloudprntProfileName: string;
  cloudprntPaperWidth: string;
  cloudprntEnabled: boolean;
  createSettlementOrderWhenPrinting: boolean;
  attachSettlementNoteToOrder: boolean;
  attachSettlementMetafieldsToOrder: boolean;
  receiptPrintMode: string;
  receiptPreviewBeforePrintRequired: boolean;
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  defaultPrintMode: "order_based",
  locationPrintModeOverrideEnabled: true,
  cloudprntProfileName: "",
  cloudprntPaperWidth: "80mm",
  cloudprntEnabled: false,
  createSettlementOrderWhenPrinting: true,
  attachSettlementNoteToOrder: true,
  attachSettlementMetafieldsToOrder: true,
  receiptPrintMode: "order_based",
  receiptPreviewBeforePrintRequired: true,
};

// ── 予算設定（要件 §11） ──────────────────────────────────────────────────────

export const BUDGET_SETTINGS_KEY = "budget_settings";

export interface BudgetSettings {
  csvColumnMappingEnabled: boolean;
  manualBudgetEditEnabled: boolean;
  bulkEditEnabled: boolean;
  budgetInputUnit: "daily" | "monthly";
  budgetApplyMode: "strict_daily" | "expand_from_monthly";
}

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
  csvColumnMappingEnabled: false,
  manualBudgetEditEnabled: true,
  bulkEditEnabled: true,
  budgetInputUnit: "daily",
  budgetApplyMode: "strict_daily",
};
