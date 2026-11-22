/**
 * 店のプランを Shopify の契約から読む（公開用）。料金プラン画面・各機能の門番（checkShopPlanAccess）が使う 1 か所。
 *
 * T の決定（2026-11-21）: 公開用の料金は Shopify App Pricing（Billing API ではない）。
 * - アプリは契約を作らない（appSubscriptionCreate は使わない）。店は Shopify の料金プラン画面でプランを選ぶ。
 * - プランは契約から読む: Admin API の currentAppInstallation.activeSubscriptions。
 *   PARTNER_API_SUBSCRIPTION_ENABLED=1 で設定がそろったときだけ、Partner API の activeSubscription も読む（既定オフ）。
 * - 読めたプランは DB の Shop.planCode にも書く（今までの画面・API が planCode を読んでいるため）。
 * - 自社用（APP_DISTRIBUTION=inhouse・Ciara）は今まで通り: Shopify に聞かず全機能・請求なし。
 * POS Stock（b3inc-dev/stock-transfer-pos の app/utils/shop-plan.server.ts、main ＋ PR #82）と同じ考え方。
 */
import {
  checkPlanAccess,
  getCustomAppStoreIds,
  isInhouseMode,
  type FeatureKey,
  type PlanAccessResult,
} from "./planFeatures.server";
import {
  getPartnerActiveSubscription,
  partnerSubscriptionToAdminShape,
  readPartnerApiConfig,
} from "./partnerSubscription.server";
import {
  computeExtraLocationUsage,
  pickUsagePeriodEnd,
  reportExtraLocationUsage,
  type UsagePeriodSource,
  type UsageReportStore,
} from "./appEventsUsage.server";

type GraphqlResponseLike = { json: () => Promise<unknown> };
export type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<GraphqlResponseLike>;
};

export type ShopRecordForPlan = { id: string; shopDomain: string; planCode: string | null };

export type SubscriptionSummary = {
  id: string;
  name: string;
  status: string;
  currentPeriodEnd: string | null;
};

export type ShopPlanState = {
  distribution: "inhouse" | "public";
  /** 全機能を使える（自社用・CUSTOM_APP_STORE_IDS・開発ストア）。今までの getFullAccess と同じ決まり */
  fullAccess: boolean;
  fullAccessReason: "inhouse" | "custom_store" | "development_store" | null;
  /** 機能の判定に使う planCode（lite / pro / unlimited） */
  planCode: string;
  /** Shopify の契約から読んだプラン。契約なし・読めなかった・自社用は null */
  plan: "lite" | "pro" | null;
  /** planCode をどこから決めたか（partner / admin = 契約、db = 契約を読めず DB の値のまま、inhouse） */
  planSource: "partner" | "admin" | "db" | "inhouse";
  /** Shopify から契約を読めたか（読めない＝未契約とは言えない） */
  subscriptionsRead: boolean;
  activeSubscriptions: SubscriptionSummary[];
  locationsCount: number;
  isDevelopmentStore: boolean;
  /** Partner API を使えなかった理由（スイッチオフ・設定不足・失敗の理由・契約なし） */
  partnerStatus?: string;
  /** プランに含まれる数（Lite 3 / Pro 10）を超えたロケーション（App Events API で 1 請求期間に 1 回報告する数） */
  extraLocationUsage?: {
    includedLocations: number;
    units: number;
    unitPriceUsd: number;
    amountUsd: number;
    /** 請求期間の終わり。どちらの API からも分からなければ null（送らずに missing_period で残す） */
    periodEnd: string | null;
    periodSource: UsagePeriodSource | null;
  };
};

export type ShopPlanDeps = {
  env?: Record<string, string | undefined>;
  /** planCode を DB に書く（既定は prisma.shop.update） */
  savePlanCode?: (shopId: string, planCode: string) => Promise<void>;
  /** 従量の記録の置き場所（既定は prisma.appUsageReport） */
  getUsageStore?: () => Promise<UsageReportStore>;
  /** Partner API を聞く関数（テスト用） */
  partnerLookup?: typeof getPartnerActiveSubscription;
  /** 従量を報告する関数（テスト用。既定は待たずに reportExtraLocationUsage） */
  reportUsage?: typeof reportExtraLocationUsage;
};

const SHOP_PLAN_QUERY = `#graphql
  query ShopPlanAndSubscriptions($first: Int!) {
    shop {
      id
      plan { partnerDevelopment }
    }
    locations(first: $first) { nodes { id } }
    currentAppInstallation {
      activeSubscriptions { id name status currentPeriodEnd }
    }
  }
`;

/**
 * 契約（App Pricing のプラン名、または Partner API の項目の handle）からプランを読む。
 * 「pro」「プロ」が入っていれば Pro、「lite」「standard」「ライト」「スタンダード」が入っていれば Lite。
 * 「product」などの一部の pro は Pro にしない（英字が前後に続かない pro だけ）。
 */
export function planFromSubscriptionName(name: string): "lite" | "pro" | null {
  const s = String(name ?? "").toLowerCase();
  if (!s.trim()) return null;
  if (/(^|[^a-z])pro([^a-z]|$)/.test(s) || s.includes("プロ")) return "pro";
  if (/lite|standard/.test(s) || s.includes("ライト") || s.includes("スタンダード")) return "lite";
  return null;
}

/** ACTIVE な契約から一番上のプランを選ぶ（Pro と Lite が両方あれば Pro） */
export function planFromSubscriptions(subs: ReadonlyArray<{ name?: string | null; status?: string | null }>): "lite" | "pro" | null {
  let best: "lite" | "pro" | null = null;
  for (const s of subs) {
    if (String(s?.status ?? "").toUpperCase() !== "ACTIVE") continue;
    const p = planFromSubscriptionName(String(s?.name ?? ""));
    if (p === "pro") return "pro";
    if (p === "lite") best = "lite";
  }
  return best;
}

function normalizeDbPlanCode(planCode: string | null | undefined): string {
  if (planCode === "pro" || planCode === "unlimited") return planCode;
  return "lite"; // standard・未設定は Lite（今まで通り）
}

/**
 * 契約から読んだプランと DB の値から、機能の判定に使う planCode を決める（純粋な関数）。
 * - DB が unlimited（手で付けた例外）はそのまま。
 * - 契約を読めたら: Pro → pro、Lite → lite、契約なし → lite（今まで通り Lite の機能は使える。未契約の店を止めるかは別に決める）。
 * - 読めなかったら DB の値のまま（払っている店を止めない）。
 */
export function decidePlanCode(args: {
  dbPlanCode: string | null | undefined;
  subscriptionsRead: boolean;
  plan: "lite" | "pro" | null;
}): { planCode: string; fromSubscription: boolean } {
  if (args.dbPlanCode === "unlimited") return { planCode: "unlimited", fromSubscription: false };
  if (!args.subscriptionsRead) return { planCode: normalizeDbPlanCode(args.dbPlanCode), fromSubscription: false };
  return { planCode: args.plan ?? "lite", fromSubscription: true };
}

async function defaultSavePlanCode(shopId: string, planCode: string) {
  const { default: prisma } = await import("../db.server");
  await prisma.shop.update({ where: { id: shopId }, data: { planCode } });
}

async function defaultUsageStore(): Promise<UsageReportStore> {
  const { default: prisma } = await import("../db.server");
  return prisma.appUsageReport as unknown as UsageReportStore;
}

function inhouseState(shop: ShopRecordForPlan): ShopPlanState {
  return {
    distribution: "inhouse",
    fullAccess: true,
    fullAccessReason: "inhouse",
    planCode: shop.planCode === "unlimited" ? "unlimited" : normalizeDbPlanCode(shop.planCode),
    plan: null,
    planSource: "inhouse",
    subscriptionsRead: false,
    activeSubscriptions: [],
    locationsCount: 0,
    isDevelopmentStore: false,
  };
}

/**
 * 店のプランを Shopify の契約から読む。投げない（読めなければ DB の値のまま）。
 * 自社用は Shopify に聞かない（Ciara の速さと請求を変えない）。
 */
export async function getShopPlan(
  admin: AdminGraphql,
  shop: ShopRecordForPlan,
  deps: ShopPlanDeps = {}
): Promise<ShopPlanState> {
  const env = deps.env ?? process.env;
  if (isInhouseMode()) return inhouseState(shop);

  const shopDomain = String(shop.shopDomain ?? "").trim().toLowerCase();
  const customStore = shopDomain !== "" && getCustomAppStoreIds().includes(shopDomain);

  let locationsCount = 0;
  let isDevelopmentStore = false;
  let shopGid: string | null = null;
  let subscriptionsRead = false;
  let activeSubscriptions: SubscriptionSummary[] = [];
  try {
    const res = await admin.graphql(SHOP_PLAN_QUERY, { variables: { first: 250 } });
    const json = (await res.json()) as {
      data?: {
        shop?: { id?: string; plan?: { partnerDevelopment?: boolean } };
        locations?: { nodes?: unknown[] };
        currentAppInstallation?: { activeSubscriptions?: unknown };
      };
    };
    const d = json?.data;
    locationsCount = Array.isArray(d?.locations?.nodes) ? d!.locations!.nodes!.length : 0;
    isDevelopmentStore = d?.shop?.plan?.partnerDevelopment === true;
    shopGid = typeof d?.shop?.id === "string" ? d.shop.id : null;
    const subs = d?.currentAppInstallation?.activeSubscriptions;
    if (Array.isArray(subs)) {
      subscriptionsRead = true;
      activeSubscriptions = subs.map((s) => {
        const r = (s ?? {}) as Record<string, unknown>;
        return {
          id: String(r.id ?? ""),
          name: String(r.name ?? ""),
          status: String(r.status ?? ""),
          currentPeriodEnd: typeof r.currentPeriodEnd === "string" ? r.currentPeriodEnd : null,
        };
      });
    }
  } catch (e) {
    console.warn("[shopPlan] plan query failed:", e instanceof Error ? e.message : String(e), "shop=", shopDomain);
  }

  let plan = subscriptionsRead ? planFromSubscriptions(activeSubscriptions) : null;
  let planSource: ShopPlanState["planSource"] = "admin";
  let partnerStatus: string | undefined;
  let partnerPeriodEnd: string | null = null;

  // Partner API（既定オフ）。契約が見つかればそれを正にする。「契約なし」なら Admin API の結果を使う（払っている店を止めない）。
  // 失敗（429・timeout など）は Admin API の結果だけで決める。
  const partnerConfig = readPartnerApiConfig(env);
  if (!partnerConfig.enabled) {
    partnerStatus = partnerConfig.reason;
    if (partnerConfig.reason === "missing_config") {
      console.warn("[shopPlan] PARTNER_API_SUBSCRIPTION_ENABLED=1 but missing:", (partnerConfig.missing ?? []).join(","));
    }
  } else if (!shopGid) {
    partnerStatus = "no_shop_id";
  } else {
    const lookup = deps.partnerLookup ?? getPartnerActiveSubscription;
    const partner = await lookup({ config: partnerConfig.config, shopGid, shop: shopDomain });
    if (!partner.ok) {
      partnerStatus = partner.reason;
    } else if (partner.subscription) {
      const shaped = partnerSubscriptionToAdminShape(partner.subscription, shopGid);
      planSource = "partner";
      subscriptionsRead = true;
      partnerPeriodEnd = partner.subscription.currentPeriodEnd;
      plan = planFromSubscriptions([shaped]);
    } else {
      partnerStatus = "none";
      // Partner は「契約なし」と答えた。Admin を読めなかったときも未契約と分かった
      if (!subscriptionsRead) {
        subscriptionsRead = true;
        plan = null;
      }
    }
  }

  const decided = decidePlanCode({ dbPlanCode: shop.planCode, subscriptionsRead, plan });
  if (!decided.fromSubscription) planSource = "db";
  if (!subscriptionsRead) {
    console.warn("[shopPlan] could not read subscriptions; keeping DB planCode. shop=", shopDomain);
  }

  // 読めたプランを DB に書く（変わったときだけ）。書けなくても判定はこの値で進める
  if (decided.fromSubscription && shop.planCode !== decided.planCode) {
    try {
      await (deps.savePlanCode ?? defaultSavePlanCode)(shop.id, decided.planCode);
    } catch (e) {
      console.warn("[shopPlan] planCode save failed:", e instanceof Error ? e.message : String(e), "shop=", shopDomain);
    }
  }

  const fullAccessReason: ShopPlanState["fullAccessReason"] = customStore
    ? "custom_store"
    : isDevelopmentStore
      ? "development_store"
      : null;
  const fullAccess = fullAccessReason !== null;

  // プランに含まれる数を超えたロケーションの従量（App Events API）。公開用・契約が Lite/Pro・全機能の例外でない店だけ。
  // 送るかどうか・1 期間 1 回・失敗の記録は appEventsUsage.server.ts。ここでは待たない（画面と POS の API を遅くしない）。
  let extraLocationUsage: ShopPlanState["extraLocationUsage"];
  if (!fullAccess && decided.fromSubscription && (plan === "lite" || plan === "pro") && decided.planCode === plan) {
    const usage = computeExtraLocationUsage(plan, locationsCount);
    if (usage.units > 0) {
      const { periodEnd, periodSource } = pickUsagePeriodEnd({
        planSource: planSource === "partner" ? "partner" : "admin",
        partnerPeriodEnd,
        adminSubscriptions: activeSubscriptions,
      });
      extraLocationUsage = {
        includedLocations: usage.includedLocations,
        units: usage.units,
        unitPriceUsd: usage.unitPriceUsd,
        amountUsd: usage.amountUsd,
        periodEnd,
        periodSource,
      };
      if (shopDomain) {
        const report = deps.reportUsage ?? reportExtraLocationUsage;
        const reportPlan = plan;
        void (deps.getUsageStore ?? defaultUsageStore)()
          .then((store) =>
            report({ shop: shopDomain, shopGid, plan: reportPlan, locationsCount, periodEnd }, { store, env })
          )
          .catch((e) => {
            console.error("[shopPlan] extra location usage report crashed:", e instanceof Error ? e.message : String(e));
          });
      }
    }
  }

  return {
    distribution: "public",
    fullAccess,
    fullAccessReason,
    planCode: decided.planCode,
    plan,
    planSource,
    subscriptionsRead,
    activeSubscriptions,
    locationsCount,
    isDevelopmentStore,
    ...(partnerStatus ? { partnerStatus } : {}),
    ...(extraLocationUsage ? { extraLocationUsage } : {}),
  };
}

// 契約を読めた店だけ少しのあいだ覚える（POS の 1 回の操作で API が何度も呼ばれるため）。読めなかった結果は覚えない。
const GATE_CACHE_MS = 60_000;
const gateCache = new Map<string, { state: ShopPlanState; at: number }>();

/** テスト用 */
export function __clearShopPlanCacheForTest() {
  gateCache.clear();
}

/**
 * 機能の門番（今までの getFullAccess ＋ checkPlanAccess(shop.planCode, …) の代わり）。
 * 自社用は Shopify に聞かずに通す。公開用は契約から読んだプランで決める。
 */
export async function checkShopPlanAccess(
  admin: AdminGraphql,
  shop: ShopRecordForPlan,
  feature: FeatureKey,
  deps: ShopPlanDeps & { now?: () => number } = {}
): Promise<PlanAccessResult & { state: ShopPlanState }> {
  if (isInhouseMode()) {
    const state = inhouseState(shop);
    return { ...checkPlanAccess(state.planCode, feature, true), state };
  }
  const now = deps.now ?? Date.now;
  const key = String(shop.shopDomain ?? "").trim().toLowerCase();
  const hit = key ? gateCache.get(key) : undefined;
  let state: ShopPlanState;
  if (hit && now() - hit.at < GATE_CACHE_MS) {
    state = hit.state;
  } else {
    state = await getShopPlan(admin, shop, deps);
    if (key && state.subscriptionsRead) gateCache.set(key, { state, at: now() });
    else if (key) gateCache.delete(key);
  }
  return { ...checkPlanAccess(state.planCode, feature, state.fullAccess), state };
}
