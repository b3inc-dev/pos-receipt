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
  | "sales_receipt"       // 販売レシート印字（Lite+）
  | "sales_receipt_layout" // 販売レシート・レイアウト編集（Lite+）
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
    { key: "sales_receipt",  label: "販売レシート印字" },
    { key: "sales_receipt_layout", label: "販売レシート・レイアウト編集" },
  ],
  pro: [
    { key: "settlement",        label: "精算・点検レシート" },
    { key: "special_refund",    label: "特殊返金・商品券調整" },
    { key: "receipt",           label: "領収書発行・再発行" },
    { key: "sales_receipt",     label: "販売レシート印字" },
    { key: "sales_receipt_layout", label: "販売レシート・レイアウト編集" },
    { key: "sales_summary",     label: "売上サマリー（日次・期間）" },
    { key: "footfall_reporting", label: "入店数報告" },
    { key: "budget_management", label: "予算管理・CSVインポート" },
  ],
};

/** 後方互換: standard を lite として参照 */
export const PLAN_FEATURES_LEGACY = { standard: PLAN_FEATURES.lite } as const;

// ── 料金プラン（Shopify App Pricing。2026-11-21 T の決定） ───
// 店は Shopify の料金プラン画面でプランを選ぶ。アプリは契約を作らない（appSubscriptionCreate は使わない）。
// 金額は Partner Dashboard の App Pricing で決まる。ここの金額は画面に見せる目安で、未確定（T がまだ決めていない）。
// プランは契約から読む（shopPlan.server.ts）。maxLocations を超えた分は 1 か所 $20/月（未確定）を
// App Events API で報告する（appEventsUsage.server.ts、APP_EVENTS_USAGE_ENABLED=1 のときだけ。既定オフ）。

export const BILLING_PLANS = {
  lite: {
    name: "Liteプラン",
    amount: 100,
    currencyCode: "USD",
    planCode: "lite" as PlanCode,
    maxLocations: 3,
    priceNote: "月額（3ロケーションまで）",
  },
  pro: {
    name: "Proプラン",
    amount: 200,
    currencyCode: "USD",
    planCode: "pro" as PlanCode,
    maxLocations: 10,
    priceNote: "月額（10ロケーションまで）",
  },
} as const;

/** プランに含まれる数を超えたロケーション 1 か所あたりの単価（USD/月）。未確定。appEventsUsage.server.ts と同じ値 */
export const EXTRA_LOCATION_PRICE_USD = 20;

/**
 * 公開アプリの App Handle（Shopify の料金プラン画面の URL 用）。
 * SHOPIFY_APP_HANDLE を優先し、無ければ "pos-receipt"（Partner Dashboard の handle と同じかは未確認。違えば env で入れる）。
 */
export function getPublicAppHandle(env: Record<string, string | undefined> = process.env): string {
  return String(env.SHOPIFY_APP_HANDLE ?? "").trim() || "pos-receipt";
}

/**
 * Shopify の料金プラン画面（App Pricing のプラン選択）の URL。
 * admin.shopify.com を使う（*.myshopify.com だと accounts.shopify.com へ飛び iframe で拒否される）。埋め込みからは target="_top" で開く。
 */
export function buildPricingPlansUrl(
  shopDomain: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): string | null {
  const shop = String(shopDomain ?? "").trim().toLowerCase();
  if (!shop) return null;
  const storeHandle = shop.replace(/^https?:\/\//, "").replace(/\.myshopify\.com.*$/i, "").split("/")[0];
  if (!storeHandle || storeHandle.includes(".") || storeHandle === "admin") return null;
  return `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}/charges/${encodeURIComponent(getPublicAppHandle(env))}/pricing_plans`;
}
