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
  selectPlanSubscription,
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
  /** 契約が作られた日。古い Billing API の契約と App Pricing の契約が両方あるとき、どちらでプランを決めたかを選ぶのに使う */
  createdAt?: string | null;
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
  /**
   * 超えたロケーションの料金で数える「POS で使うロケーション」の数（2026-11-22 T の決定）。
   * 直近 POS_LOCATION_WINDOW_DAYS 日に、精算・領収書・特殊返金をこのアプリで使った、今も有効なロケーション。
   * 数えなかった（契約なし・全機能の例外など）・数えられなかったときは null
   */
  posLocationsCount: number | null;
  isDevelopmentStore: boolean;
  /** Partner API を使えなかった理由（スイッチオフ・設定不足・失敗の理由・契約なし） */
  partnerStatus?: string;
  /**
   * 超えたロケーションを数えたか・数えなかった理由（料金プラン画面の文言を分ける）。
   * counted = 超えた分を数えた（extraLocationUsage あり）、within_plan = 契約のプランの範囲内、
   * no_subscription = 有効な契約が無い、unread = 契約を読めなかった、full_access = 全機能の例外（自社用・開発ストアなど）、
   * not_counted = 契約と使っているプランが違う（DB の unlimited など）
   */
  extraLocationStatus: ExtraLocationStatus;
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

export type ExtraLocationStatus =
  | "counted"
  | "within_plan"
  | "no_subscription"
  | "unread"
  | "full_access"
  | "not_counted"
  | "count_failed";

/**
 * 超えたロケーションを数える店か・数えない理由（純粋な関数）。
 * 契約が無い・読めない店に「プランの範囲内です」と出さないため、理由を分ける。
 */
export function decideExtraLocationStatus(args: {
  fullAccess: boolean;
  subscriptionsRead: boolean;
  plan: "lite" | "pro" | null;
  planCode: string;
  fromSubscription: boolean;
  extraUnits: number;
  /** POS で使うロケーションを DB から数えられなかった */
  countFailed?: boolean;
}): ExtraLocationStatus {
  if (args.fullAccess) return "full_access";
  if (!args.subscriptionsRead) return "unread";
  if (args.plan === null) return "no_subscription";
  if (!args.fromSubscription || args.planCode !== args.plan) return "not_counted";
  if (args.countFailed) return "count_failed";
  return args.extraUnits > 0 ? "counted" : "within_plan";
}

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
  /** 門番の覚えの時刻（テスト用。既定は Date.now） */
  now?: () => number;
  /** POS で使ったロケーションの ID（Location の GID）を DB から読む（テスト用。既定は prisma） */
  listUsedLocationIds?: (shopId: string, since: Date) => Promise<string[]>;
};

/** 「POS で使うロケーション」を見る日数（2026-11-23 T がカードで確定。docs/DECISIONS.md D16） */
export const POS_LOCATION_WINDOW_DAYS = 30;

/**
 * POS で使うロケーションの数（純粋な関数）: 直近に使った ID のうち、今 Shopify で有効なロケーションだけ・重なりなし。
 * 消した・止めたロケーションは数えない。
 */
export function countPosLocations(usedLocationIds: ReadonlyArray<string>, activeLocationIds: ReadonlyArray<string>): number {
  const active = new Set(activeLocationIds.map((id) => String(id)));
  const used = new Set(usedLocationIds.map((id) => String(id)).filter((id) => active.has(id)));
  return used.size;
}

/** 精算・領収書・特殊返金を直近に使ったロケーションの ID（Shopify の Location GID） */
async function defaultListUsedLocationIds(shopId: string, since: Date): Promise<string[]> {
  const { default: prisma } = await import("../db.server");
  const where = { shopId, createdAt: { gte: since } };
  const [settlements, receipts, refunds] = await Promise.all([
    prisma.settlement.findMany({ where, select: { locationId: true }, distinct: ["locationId"] }),
    prisma.receiptIssue.findMany({ where, select: { locationId: true }, distinct: ["locationId"] }),
    prisma.specialRefundEvent.findMany({ where, select: { locationId: true }, distinct: ["locationId"] }),
  ]);
  return [...settlements, ...receipts, ...refunds].map((r) => r.locationId);
}

const SHOP_PLAN_QUERY = `#graphql
  query ShopPlanAndSubscriptions($first: Int!) {
    shop {
      id
      plan { partnerDevelopment }
    }
    locations(first: $first) { nodes { id } }
    currentAppInstallation {
      activeSubscriptions { id name status currentPeriodEnd createdAt }
    }
  }
`;

/**
 * 契約（App Pricing のプラン名、または Partner API の項目の handle）からプランを読む。
 * 「pro」「プロ」が入っていれば Pro、「lite」「standard」「ライト」「スタンダード」が入っていれば Lite。
 * 「product」などの一部の pro は Pro にしない（英字が前後に続かない pro だけ）。
 * lite・standard も同じで、「Elite」などの一部の lite は Lite にしない（英字が前後に続かないものだけ）。
 */
export function planFromSubscriptionName(name: string): "lite" | "pro" | null {
  const s = String(name ?? "").toLowerCase();
  if (!s.trim()) return null;
  if (/(^|[^a-z])pro([^a-z]|$)/.test(s) || s.includes("プロ")) return "pro";
  if (/(^|[^a-z])(lite|standard)([^a-z]|$)/.test(s) || s.includes("ライト") || s.includes("スタンダード")) return "lite";
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
    posLocationsCount: null,
    isDevelopmentStore: false,
    extraLocationStatus: "full_access",
  };
}

/**
 * PLAN_TEST_DEV_STORE_AS_PUBLIC=1 のとき、開発ストアを全機能の例外にしない（App Pricing の確かめ用・既定オフ）。
 * 自社用（inhouse）には効かない（getShopPlan の先頭で返る）。
 */
export function isDevStoreTreatedAsPublic(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.PLAN_TEST_DEV_STORE_AS_PUBLIC ?? "").trim() === "1";
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
  let activeLocationIds: string[] = [];
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
    const locationNodes = Array.isArray(d?.locations?.nodes) ? d!.locations!.nodes! : [];
    locationsCount = locationNodes.length;
    activeLocationIds = locationNodes
      .map((n) => String(((n ?? {}) as { id?: unknown }).id ?? ""))
      .filter(Boolean);
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
          createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
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
  /** Partner で契約が見つかったときの、その契約の Admin 側の id（legacySubscriptionId。Admin の契約と結びつける） */
  let partnerSubscriptionId: string | null = null;

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
      partnerSubscriptionId = partner.subscription.legacySubscriptionId ?? null;
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

  // 開発ストアは今まで通り全機能。ただし PLAN_TEST_DEV_STORE_AS_PUBLIC=1（公開用の Render だけ・既定オフ）のときは、
  // 開発ストアもふつうの店と同じく契約からプランを決める（Partner Dashboard の App Pricing を開発ストアで確かめるため。
  // 開発ストアの請求は Shopify のテスト扱い。docs/PARTNER_DASHBOARD_PRICING_SETUP.md）
  const fullAccessReason: ShopPlanState["fullAccessReason"] = customStore
    ? "custom_store"
    : isDevelopmentStore && !isDevStoreTreatedAsPublic(env)
      ? "development_store"
      : null;
  const fullAccess = fullAccessReason !== null;

  // プランに含まれる数を超えたロケーションの従量（App Events API）。公開用・契約が Lite/Pro・全機能の例外でない店だけ。
  // 送るかどうか・1 期間 1 回・失敗の記録は appEventsUsage.server.ts。ここでは待たない（画面と POS の API を遅くしない）。
  let extraLocationUsage: ShopPlanState["extraLocationUsage"];
  let extraUnits = 0;
  let posLocationsCount: number | null = null;
  let countFailed = false;
  const countsExtraLocations =
    !fullAccess && decided.fromSubscription && (plan === "lite" || plan === "pro") && decided.planCode === plan;
  if (countsExtraLocations) {
    // 数えるのは POS で使うロケーションだけ（2026-11-22 T の決定）。DB を読めなければ数えず、報告もしない
    try {
      const since = new Date((deps.now ?? Date.now)() - POS_LOCATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const used = await (deps.listUsedLocationIds ?? defaultListUsedLocationIds)(shop.id, since);
      posLocationsCount = countPosLocations(used, activeLocationIds);
    } catch (e) {
      countFailed = true;
      console.warn("[shopPlan] POS location count failed:", e instanceof Error ? e.message : String(e), "shop=", shopDomain);
    }
  }
  if (countsExtraLocations && posLocationsCount !== null && (plan === "lite" || plan === "pro")) {
    const usage = computeExtraLocationUsage(plan, posLocationsCount);
    extraUnits = usage.units;
    if (usage.units > 0) {
      // 期間はプランを決めた契約から取る（古い Billing API の契約が同時に ACTIVE でも、そちらの期間を使わない）
      const reportPlanForPick = plan;
      const planSubscription = selectPlanSubscription(activeSubscriptions, {
        preferId: planSource === "partner" ? partnerSubscriptionId : null,
        matches: (s) => planFromSubscriptionName(s.name) === reportPlanForPick,
      });
      const { periodEnd, periodSource } = pickUsagePeriodEnd({
        planSource: planSource === "partner" ? "partner" : "admin",
        partnerPeriodEnd,
        planSubscription,
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
        const reportCount = posLocationsCount;
        void (deps.getUsageStore ?? defaultUsageStore)()
          .then((store) =>
            report({ shop: shopDomain, shopGid, plan: reportPlan, locationsCount: reportCount, periodEnd }, { store, env })
          )
          .catch((e) => {
            console.error("[shopPlan] extra location usage report crashed:", e instanceof Error ? e.message : String(e));
          });
      }
    }
  }

  const state: ShopPlanState = {
    distribution: "public",
    fullAccess,
    fullAccessReason,
    planCode: decided.planCode,
    plan,
    planSource,
    subscriptionsRead,
    activeSubscriptions,
    locationsCount,
    posLocationsCount,
    isDevelopmentStore,
    extraLocationStatus: decideExtraLocationStatus({
      fullAccess,
      subscriptionsRead,
      plan,
      planCode: decided.planCode,
      fromSubscription: decided.fromSubscription,
      extraUnits,
      countFailed,
    }),
    ...(partnerStatus ? { partnerStatus } : {}),
    ...(extraLocationUsage ? { extraLocationUsage } : {}),
  };
  // 門番の覚えも今読んだ結果で置きかえる。プランを変えてアプリに戻ったとき（ホーム・料金プラン画面が読む）、
  // 前に覚えた古いプランで最大 60 秒 Pro の機能を断らないように。読めなかったときは覚えを消す
  rememberGateState(shopDomain, state, deps.now ?? Date.now);
  return state;
}

// 契約を読めた店だけ少しのあいだ覚える（POS の 1 回の操作で API が何度も呼ばれるため）。読めなかった結果は覚えない。
const GATE_CACHE_MS = 60_000;
const gateCache = new Map<string, { state: ShopPlanState; at: number }>();

function rememberGateState(key: string, state: ShopPlanState, now: () => number) {
  if (!key) return;
  if (state.subscriptionsRead) gateCache.set(key, { state, at: now() });
  else gateCache.delete(key);
}

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
  deps: ShopPlanDeps = {}
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
    state = await getShopPlan(admin, shop, { ...deps, now }); // 覚えるのは getShopPlan の中（rememberGateState）
  }
  return { ...checkPlanAccess(state.planCode, feature, state.fullAccess), state };
}

// ── 未契約の店を止める（2026-11-22 T の決定: POS Stock と同じ）───────────────────

/**
 * 未契約の店を止めるスイッチ PLAN_REQUIRE_SUBSCRIPTION=1（公開用の Render だけ・既定オフ）。
 * Admin API に App Pricing の契約が出ることを開発ストアで確かめてからオンにする
 * （出ないまま入れると、払っている店まで「未契約」と読んで止めてしまうため）。
 */
export function isSubscriptionRequired(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.PLAN_REQUIRE_SUBSCRIPTION ?? "").trim() === "1";
}

/**
 * この店を止めるか（純粋な関数）。止めるのは、公開用・全機能の例外でない・契約を読めて有効な契約が無い・DB が unlimited でない店だけ。
 * 契約を読めなかったときは止めない（払っている店を止めない）。
 */
export function shouldBlockForNoSubscription(
  state: Pick<ShopPlanState, "distribution" | "fullAccess" | "subscriptionsRead" | "plan" | "planCode">,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!isSubscriptionRequired(env)) return false;
  if (state.distribution !== "public" || state.fullAccess) return false;
  if (!state.subscriptionsRead) return false;
  if (state.planCode === "unlimited") return false;
  return state.plan === null;
}

/** POS の API が未契約の店に返す文（POS の画面にそのまま出る） */
export const PLAN_REQUIRED_MESSAGE = "プランが選ばれていません。Shopify 管理画面のアプリの「料金プラン」でプランを選んでください。";

/**
 * 未契約の店を止めるかを、門番と同じ覚え（60 秒）を使って調べる。自社用は Shopify に聞かずに通す。
 * スイッチがオフなら Shopify に聞かずに通す（今までの速さのまま）。
 */
export async function checkSubscriptionGate(
  admin: AdminGraphql,
  shop: ShopRecordForPlan,
  deps: ShopPlanDeps = {}
): Promise<{ blocked: boolean; state: ShopPlanState | null }> {
  const env = deps.env ?? process.env;
  if (isInhouseMode() || !isSubscriptionRequired(env)) return { blocked: false, state: null };
  const now = deps.now ?? Date.now;
  const key = String(shop.shopDomain ?? "").trim().toLowerCase();
  const hit = key ? gateCache.get(key) : undefined;
  const state = hit && now() - hit.at < GATE_CACHE_MS ? hit.state : await getShopPlan(admin, shop, { ...deps, now });
  return { blocked: shouldBlockForNoSubscription(state, env), state };
}
