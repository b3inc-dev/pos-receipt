/**
 * プラン別機能フラグ
 * 要件書 §3: プラン構成
 *
 * 以下は常に全機能を解放する（POS Stock と同様）:
 * - APP_DISTRIBUTION=inhouse（自社用）
 * - CUSTOM_APP_STORE_IDS に含まれるショップドメイン（カスタム／開発用）
 * - Shopify の開発ストア（shop.plan.partnerDevelopment）
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

const SHOP_PLAN_QUERY = `#graphql
  query ShopPlan { shop { plan { partnerDevelopment } } }
`;

/** カスタムアプリとして扱うショップドメイン一覧（カンマ区切り）。ここに含まれるストアは常に全機能解放。 */
export function getCustomAppStoreIds(): string[] {
  const raw = process.env.CUSTOM_APP_STORE_IDS ?? "";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 自社用判定（APP_DISTRIBUTION=inhouse のとき true）。getFullAccess の一部としても使用。大文字小文字は無視。 */
export function isInhouseMode(): boolean {
  const v = (process.env.APP_DISTRIBUTION ?? "").trim().toLowerCase();
  return v === "inhouse";
}

/**
 * 全機能解放かどうか（自社用・CUSTOM_APP_STORE_IDS・開発ストアのいずれかで true）。
 * 管理画面・API の loader で使い、isInhouse の代わりに返す。
 */
export async function getFullAccess(
  admin: { graphql: (query: string) => Promise<Response> },
  session: { shop: string }
): Promise<boolean> {
  if (isInhouseMode()) return true;
  const customIds = getCustomAppStoreIds();
  const shopNorm = session.shop.trim().toLowerCase();
  if (shopNorm && customIds.some((id) => id === shopNorm)) return true;
  try {
    const res = await admin.graphql(SHOP_PLAN_QUERY);
    const json = (await res.json()) as { data?: { shop?: { plan?: { partnerDevelopment?: boolean } } } };
    if (json?.data?.shop?.plan?.partnerDevelopment === true) return true;
  } catch {
    // ignore
  }
  return false;
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

export function checkPlanAccess(
  planCode: string | null,
  feature: FeatureKey,
  fullAccess?: boolean
): PlanAccessResult {
  if (fullAccess === true || planCode === "unlimited") {
    return { allowed: true, message: "" };
  }
  if (isInhouseMode()) {
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
