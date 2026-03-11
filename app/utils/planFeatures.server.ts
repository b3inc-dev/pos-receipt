/**
 * プラン別機能フラグ
 * 要件書 §3: プラン構成
 *
 * APP_DISTRIBUTION=inhouse のときは全機能を無制限で許可する。
 */

export type PlanCode = "standard" | "pro" | "unlimited";

// ── フィーチャーキー定義 ────────────────────────────────────────────────────

export type FeatureKey =
  | "settlement"          // 精算（全プラン）
  | "special_refund"      // 特殊返金・商品券調整（全プラン）
  | "receipt"             // 領収書（全プラン）
  | "sales_summary"       // 売上サマリー（Pro+）
  | "footfall_reporting"  // 入店数報告（Pro+）
  | "budget_management";  // 予算管理（Pro+）

const PRO_FEATURES: FeatureKey[] = [
  "sales_summary",
  "footfall_reporting",
  "budget_management",
];

// ── 自社用判定（APP_DISTRIBUTION=inhouse → 無制限） ──────────────────────────

export function isInhouseMode(): boolean {
  return process.env.APP_DISTRIBUTION === "inhouse";
}

// ── プラン表示名 ────────────────────────────────────────────────────────────

export function planLabel(planCode: string | null): string {
  if (isInhouseMode()) return "自社用（無制限）";
  switch (planCode) {
    case "pro":       return "プロプラン";
    case "unlimited": return "アンリミテッド";
    default:          return "スタンダードプラン";
  }
}

// ── フィーチャーアクセスチェック ─────────────────────────────────────────────

export interface PlanAccessResult {
  allowed: boolean;
  message: string;
}

export function checkPlanAccess(planCode: string | null, feature: FeatureKey): PlanAccessResult {
  // 自社用 or unlimited は全機能許可
  if (isInhouseMode() || planCode === "unlimited") {
    return { allowed: true, message: "" };
  }

  const isProRequired = PRO_FEATURES.includes(feature);
  if (isProRequired && planCode !== "pro") {
    return {
      allowed: false,
      message: "この機能はプロプランでのみ利用できます。管理画面からアップグレードしてください。",
    };
  }

  return { allowed: true, message: "" };
}

// ── プラン別フィーチャー一覧 ─────────────────────────────────────────────────

export const PLAN_FEATURES: Record<"standard" | "pro", { key: FeatureKey; label: string }[]> = {
  standard: [
    { key: "settlement",     label: "精算・点検レシート" },
    { key: "special_refund", label: "特殊返金・商品券調整" },
    { key: "receipt",        label: "領収書発行・再発行" },
  ],
  pro: [
    { key: "settlement",        label: "精算・点検レシート" },
    { key: "special_refund",    label: "特殊返金・商品券調整" },
    { key: "receipt",           label: "領収書発行・再発行" },
    { key: "sales_summary",     label: "売上サマリー（日次・期間）" },
    { key: "footfall_reporting", label: "入店数報告" },
    { key: "budget_management", label: "予算管理・CSVインポート" },
  ],
};

// ── Shopify Billing プラン名 ─────────────────────────────────────────────────

export const BILLING_PLANS = {
  standard: {
    name: "スタンダードプラン",
    amount: 2980,
    currencyCode: "JPY",
    planCode: "standard" as PlanCode,
  },
  pro: {
    name: "プロプラン",
    amount: 5980,
    currencyCode: "JPY",
    planCode: "pro" as PlanCode,
  },
} as const;
