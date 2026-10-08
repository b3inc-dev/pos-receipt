/**
 * ロケーション設定軸（プロファイル）— クライアント／サーバー共有
 *（prisma 非依存のため .server に置かない）
 */

export interface LocationProfileFields {
  printMode?: string;
  salesSummaryEnabled?: boolean;
  settlementEnabled?: boolean;
  receiptEnabled?: boolean;
  specialRefundEnabled?: boolean;
  voucherAdjustmentEnabled?: boolean;
  inspectionReceiptEnabled?: boolean;
  includeInStoreTotals?: boolean;
  includeInOverallTotals?: boolean;
  visibleInSummaryDefault?: boolean;
  printerProfileId?: string | null;
  cloudprntEnabled?: boolean;
  summaryTargetGroup?: string | null;
  budgetTargetEnabled?: boolean;
  footfallTargetEnabled?: boolean;
}

export interface LocationSettingProfile {
  id: string;
  name: string;
  fields: LocationProfileFields;
  updatedAt: string;
}

export interface LocationProfilesState {
  profiles: LocationSettingProfile[];
}

export const DEFAULT_LOCATION_PROFILES: LocationProfilesState = {
  profiles: [],
};

export const LOCATION_PROFILE_FIELD_KEYS: (keyof LocationProfileFields)[] = [
  "printMode",
  "salesSummaryEnabled",
  "settlementEnabled",
  "receiptEnabled",
  "specialRefundEnabled",
  "voucherAdjustmentEnabled",
  "inspectionReceiptEnabled",
  "includeInStoreTotals",
  "includeInOverallTotals",
  "visibleInSummaryDefault",
  "printerProfileId",
  "cloudprntEnabled",
  "summaryTargetGroup",
  "budgetTargetEnabled",
  "footfallTargetEnabled",
];

export const LOCATION_PROFILES_KEY = "location_setting_profiles";
