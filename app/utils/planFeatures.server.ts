/**
 * プラン別機能フラグ
 * 要件書 §3: プラン構成
 *
 * 以下は常に全機能を解放する（POS Stock と同様）:
 * - APP_DISTRIBUTION=inhouse（自社用）
 * - CUSTOM_APP_STORE_IDS に含まれるショップドメイン（カスタム／開発用）
 * - Shopify の開発ストア（shop.plan.partnerDevelopment）
 */

export type PlanCode = "lite" | "pro" | "unlimited" | "standard"; // standard は後方互換のため残す（Lite 相当）

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
    case "pro":       return "Proプラン";
    case "unlimited": return "アンリミテッド";
    case "lite":
    case "standard":  return "Liteプラン"; // standard は旧名称・Lite 相当
    default:          return "Liteプラン";
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
  const isPro = planCode === "pro" || planCode === "unlimited";
  if (isProRequired && !isPro) {
    return {
      allowed: false,
      message: "この機能はプロプランでのみ利用できます。管理画面からアップグレードしてください。",
    };
  }

  return { allowed: true, message: "" };
}

// ── プラン別フィーチャー一覧 ─────────────────────────────────────────────────

export const PLAN_FEATURES: Record<"lite" | "pro", { key: FeatureKey; label: string }[]> = {
  lite: [
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

/** 後方互換: standard を lite として参照 */
export const PLAN_FEATURES_LEGACY = { standard: PLAN_FEATURES.lite } as const;

// ── Shopify Billing プラン（POS Receipt: Lite $100/3ロケーション、Pro $200/10ロケーション、11ロケーション以降 $20/ロケーション） ───

export const BILLING_PLANS = {
  lite: {
    name: "Liteプラン",
    amount: 100,
    currencyCode: "USD",
    planCode: "lite" as PlanCode,
    maxLocations: 3,
    priceNote: "3ロケーションまで",
  },
  pro: {
    name: "Proプラン",
    amount: 200,
    currencyCode: "USD",
    planCode: "pro" as PlanCode,
    maxLocations: 10,
    priceNote: "10ロケーションまで",
  },
} as const;

/** 11ロケーション以降の追加料金（USD/月・1ロケーションあたり） */
export const EXTRA_LOCATION_PRICE_USD = 20;
