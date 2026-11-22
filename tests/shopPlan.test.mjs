import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  __clearShopPlanCacheForTest,
  checkShopPlanAccess,
  decidePlanCode,
  getShopPlan,
  planFromSubscriptionName,
  planFromSubscriptions,
} from "../app/utils/shopPlan.server.ts";
import { buildPricingPlansUrl, getPublicAppHandle } from "../app/utils/planFeatures.server.ts";

// 合成データだけを使う。本物の Shopify にはつながない。
const SHOP = { id: "s1", shopDomain: "demo.myshopify.com", planCode: "lite" };
const GID = "gid://shopify/Shop/12345678";
const PERIOD = "2099-12-21T00:00:00Z";

function fakeAdmin({ subs = [], locations = 1, dev = false, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async graphql(query, opts) {
      calls.push({ query, opts });
      if (fail) throw new Error("graphql down");
      return {
        json: async () => ({
          data: {
            shop: { id: GID, plan: { partnerDevelopment: dev } },
            locations: { nodes: Array.from({ length: locations }, (_, i) => ({ id: `gid://shopify/Location/${i}` })) },
            currentAppInstallation: subs === null ? null : { activeSubscriptions: subs },
          },
        }),
      };
    },
  };
}

const sub = (name, status = "ACTIVE") => ({ id: `gid://shopify/AppSubscription/${name}`, name, status, currentPeriodEnd: PERIOD });

function deps(over = {}) {
  const saved = [];
  const reports = [];
  return {
    saved,
    reports,
    env: {},
    savePlanCode: async (id, planCode) => {
      saved.push({ id, planCode });
    },
    getUsageStore: async () => ({}),
    reportUsage: async (input) => {
      reports.push(input);
      return { outcome: "skipped", reason: "recently_checked" };
    },
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let savedEnv;
beforeEach(() => {
  savedEnv = { APP_DISTRIBUTION: process.env.APP_DISTRIBUTION, CUSTOM_APP_STORE_IDS: process.env.CUSTOM_APP_STORE_IDS };
  delete process.env.APP_DISTRIBUTION;
  delete process.env.CUSTOM_APP_STORE_IDS;
  __clearShopPlanCacheForTest();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("契約の名前からプランを読む", () => {
  test("Pro / Lite（日本語・handle・旧 Billing API の名前も）", () => {
    assert.equal(planFromSubscriptionName("Proプラン"), "pro");
    assert.equal(planFromSubscriptionName("pro"), "pro");
    assert.equal(planFromSubscriptionName("POS Receipt Pro"), "pro");
    assert.equal(planFromSubscriptionName("プロ"), "pro");
    assert.equal(planFromSubscriptionName("Liteプラン"), "lite");
    assert.equal(planFromSubscriptionName("lite"), "lite");
    assert.equal(planFromSubscriptionName("Standard"), "lite");
    assert.equal(planFromSubscriptionName("product bundle"), null);
    assert.equal(planFromSubscriptionName(""), null);
  });
  test("ACTIVE だけを見て、Pro と Lite があれば Pro", () => {
    assert.equal(planFromSubscriptions([sub("Lite"), sub("Pro")]), "pro");
    assert.equal(planFromSubscriptions([sub("Pro", "CANCELLED"), sub("Lite")]), "lite");
    assert.equal(planFromSubscriptions([]), null);
  });
  test("planCode の決め方: unlimited は残す・読めなければ DB のまま・契約なしは lite", () => {
    assert.deepEqual(decidePlanCode({ dbPlanCode: "unlimited", subscriptionsRead: true, plan: null }), { planCode: "unlimited", fromSubscription: false });
    assert.deepEqual(decidePlanCode({ dbPlanCode: "pro", subscriptionsRead: false, plan: null }), { planCode: "pro", fromSubscription: false });
    assert.deepEqual(decidePlanCode({ dbPlanCode: "standard", subscriptionsRead: false, plan: null }), { planCode: "lite", fromSubscription: false });
    assert.deepEqual(decidePlanCode({ dbPlanCode: "pro", subscriptionsRead: true, plan: null }), { planCode: "lite", fromSubscription: true });
    assert.deepEqual(decidePlanCode({ dbPlanCode: "lite", subscriptionsRead: true, plan: "pro" }), { planCode: "pro", fromSubscription: true });
  });
});

describe("getShopPlan", () => {
  test("自社用（inhouse）は Shopify に聞かず全機能・報告しない", async () => {
    process.env.APP_DISTRIBUTION = "inhouse";
    const admin = fakeAdmin({ subs: [sub("Pro")], locations: 30 });
    const d = deps();
    const state = await getShopPlan(admin, SHOP, d);
    assert.equal(state.distribution, "inhouse");
    assert.equal(state.fullAccess, true);
    assert.equal(admin.calls.length, 0);
    assert.equal(d.saved.length, 0);
    await flush();
    assert.equal(d.reports.length, 0);
    const gate = await checkShopPlanAccess(admin, SHOP, "sales_summary", d);
    assert.equal(gate.allowed, true);
    assert.equal(admin.calls.length, 0);
  });

  test("Admin API の契約が Pro なら pro にして DB に書く", async () => {
    const d = deps();
    const state = await getShopPlan(fakeAdmin({ subs: [sub("Proプラン")] }), SHOP, d);
    assert.equal(state.plan, "pro");
    assert.equal(state.planCode, "pro");
    assert.equal(state.planSource, "admin");
    assert.deepEqual(d.saved, [{ id: "s1", planCode: "pro" }]);
  });

  test("契約なしは lite（今まで通り Lite の機能は使える）。DB の pro も lite に戻す", async () => {
    const d = deps();
    const state = await getShopPlan(fakeAdmin({ subs: [] }), { ...SHOP, planCode: "pro" }, d);
    assert.equal(state.plan, null);
    assert.equal(state.planCode, "lite");
    assert.deepEqual(d.saved, [{ id: "s1", planCode: "lite" }]);
  });

  test("契約を読めなければ DB の値のまま（書かない）", async () => {
    const d = deps();
    const state = await getShopPlan(fakeAdmin({ fail: true }), { ...SHOP, planCode: "pro" }, d);
    assert.equal(state.subscriptionsRead, false);
    assert.equal(state.planCode, "pro");
    assert.equal(state.planSource, "db");
    assert.equal(d.saved.length, 0);
  });

  test("DB の unlimited は契約で上書きしない・報告しない", async () => {
    const d = deps();
    const state = await getShopPlan(fakeAdmin({ subs: [sub("Lite")], locations: 9 }), { ...SHOP, planCode: "unlimited" }, d);
    assert.equal(state.planCode, "unlimited");
    assert.equal(state.extraLocationUsage, undefined);
    assert.equal(d.saved.length, 0);
    await flush();
    assert.equal(d.reports.length, 0);
  });

  test("Partner API（スイッチオン）で契約が見つかればそれを正にし、その期間で報告する", async () => {
    const d = deps({
      env: { PARTNER_API_SUBSCRIPTION_ENABLED: "1", PARTNER_API_TOKEN: "t", PARTNER_API_ORG_ID: "123", PARTNER_API_APP_ID: "456" },
      partnerLookup: async () => ({
        ok: true,
        cached: false,
        subscription: { handles: ["pro"], name: "pro", billingPeriod: "MONTHLY", cancelAtEndOfCycle: false, trialEndsAt: null, currentPeriodEnd: "2099-11-30T00:00:00Z", legacySubscriptionId: null },
      }),
    });
    const state = await getShopPlan(fakeAdmin({ subs: [], locations: 12 }), SHOP, d);
    assert.equal(state.planSource, "partner");
    assert.equal(state.planCode, "pro");
    assert.equal(state.extraLocationUsage.units, 2);
    assert.equal(state.extraLocationUsage.periodSource, "partner");
    await flush();
    assert.equal(d.reports.length, 1);
    assert.deepEqual(d.reports[0], { shop: "demo.myshopify.com", shopGid: GID, plan: "pro", locationsCount: 12, periodEnd: "2099-11-30T00:00:00.000Z" });
  });

  test("Partner の失敗は Admin の結果で決める", async () => {
    const d = deps({
      env: { PARTNER_API_SUBSCRIPTION_ENABLED: "1", PARTNER_API_TOKEN: "t", PARTNER_API_ORG_ID: "123", PARTNER_API_APP_ID: "456" },
      partnerLookup: async () => ({ ok: false, reason: "timeout" }),
    });
    const state = await getShopPlan(fakeAdmin({ subs: [sub("Lite")] }), SHOP, d);
    assert.equal(state.planSource, "admin");
    assert.equal(state.partnerStatus, "timeout");
    assert.equal(state.planCode, "lite");
  });

  test("スイッチオフ（既定）では Partner に聞かない", async () => {
    let asked = 0;
    const d = deps({ partnerLookup: async () => { asked++; return { ok: true, subscription: null, cached: false }; } });
    const state = await getShopPlan(fakeAdmin({ subs: [sub("Lite")] }), SHOP, d);
    assert.equal(asked, 0);
    assert.equal(state.partnerStatus, "switch_off");
  });

  test("Lite で 3 か所を超えたら超えた分を報告に回す（待たない）。3 か所までは回さない", async () => {
    const d = deps();
    const state = await getShopPlan(fakeAdmin({ subs: [sub("Lite")], locations: 5 }), SHOP, d);
    assert.deepEqual(
      { ...state.extraLocationUsage },
      { includedLocations: 3, units: 2, unitPriceUsd: 20, amountUsd: 40, periodEnd: "2099-12-21T00:00:00.000Z", periodSource: "admin" }
    );
    await flush();
    assert.equal(d.reports.length, 1);
    assert.equal(d.reports[0].plan, "lite");

    const d2 = deps();
    const s2 = await getShopPlan(fakeAdmin({ subs: [sub("Lite")], locations: 3 }), SHOP, d2);
    assert.equal(s2.extraLocationUsage, undefined);
    await flush();
    assert.equal(d2.reports.length, 0);
  });

  test("開発ストア・CUSTOM_APP_STORE_IDS は今まで通り全機能で、報告しない", async () => {
    const d = deps();
    const dev = await getShopPlan(fakeAdmin({ subs: [sub("Lite")], locations: 9, dev: true }), SHOP, d);
    assert.equal(dev.fullAccess, true);
    assert.equal(dev.fullAccessReason, "development_store");
    assert.equal(dev.extraLocationUsage, undefined);
    process.env.CUSTOM_APP_STORE_IDS = "demo.myshopify.com";
    const custom = await getShopPlan(fakeAdmin({ subs: [], locations: 9 }), SHOP, d);
    assert.equal(custom.fullAccessReason, "custom_store");
    await flush();
    assert.equal(d.reports.length, 0);
  });

  test("報告が失敗しても getShopPlan は投げない", async () => {
    const d = deps({ reportUsage: async () => { throw new Error("db down"); } });
    const origError = console.error;
    console.error = () => {};
    try {
      const state = await getShopPlan(fakeAdmin({ subs: [sub("Pro")], locations: 11 }), SHOP, d);
      assert.equal(state.planCode, "pro");
      await flush();
    } finally {
      console.error = origError;
    }
  });
});

describe("checkShopPlanAccess（門番）", () => {
  test("Lite は売上サマリーを使えない・Pro は使える", async () => {
    const lite = await checkShopPlanAccess(fakeAdmin({ subs: [sub("Lite")] }), SHOP, "sales_summary", deps());
    assert.equal(lite.allowed, false);
    __clearShopPlanCacheForTest();
    const pro = await checkShopPlanAccess(fakeAdmin({ subs: [sub("Pro")] }), SHOP, "sales_summary", deps());
    assert.equal(pro.allowed, true);
    assert.equal((await checkShopPlanAccess(fakeAdmin({ subs: [] }), { ...SHOP, shopDomain: "other.myshopify.com" }, "settlement", deps())).allowed, true);
  });

  test("読めた結果は 60 秒覚える。読めなかった結果は覚えない", async () => {
    let now = 0;
    const admin = fakeAdmin({ subs: [sub("Pro")] });
    await checkShopPlanAccess(admin, SHOP, "sales_summary", { ...deps(), now: () => now });
    await checkShopPlanAccess(admin, SHOP, "sales_summary", { ...deps(), now: () => now });
    assert.equal(admin.calls.length, 1);
    now += 60_001;
    await checkShopPlanAccess(admin, SHOP, "sales_summary", { ...deps(), now: () => now });
    assert.equal(admin.calls.length, 2);

    const failing = fakeAdmin({ fail: true });
    const shop2 = { ...SHOP, shopDomain: "x.myshopify.com", planCode: "pro" };
    const r = await checkShopPlanAccess(failing, shop2, "sales_summary", { ...deps(), now: () => now });
    assert.equal(r.allowed, true); // DB の pro のまま
    await checkShopPlanAccess(failing, shop2, "sales_summary", { ...deps(), now: () => now });
    assert.equal(failing.calls.length, 2);
  });
});

describe("プランを変えたあとの門番", () => {
  test("ホーム・料金プラン画面が契約を読み直したら、門番の覚えもその結果になる（60 秒待たずに Pro を使える）", async () => {
    let now = 0;
    const before = await checkShopPlanAccess(fakeAdmin({ subs: [sub("Lite")] }), SHOP, "sales_summary", { ...deps(), now: () => now });
    assert.equal(before.allowed, false);
    now += 10_000;
    // 店が Shopify の料金プラン画面で Pro にしてアプリに戻る → ホームの loader が getShopPlan を呼ぶ
    await getShopPlan(fakeAdmin({ subs: [sub("Pro")] }), SHOP, { ...deps(), now: () => now });
    const gateAdmin = fakeAdmin({ subs: [sub("Pro")] });
    const after = await checkShopPlanAccess(gateAdmin, SHOP, "sales_summary", { ...deps(), now: () => now });
    assert.equal(after.allowed, true);
    assert.equal(gateAdmin.calls.length, 0); // 読み直した結果を使う（もう一度は聞かない）
  });

  test("読み直しで読めなかったら覚えを消す（古いプランを使い続けない）", async () => {
    let now = 0;
    await checkShopPlanAccess(fakeAdmin({ subs: [sub("Pro")] }), SHOP, "sales_summary", { ...deps(), now: () => now });
    await getShopPlan(fakeAdmin({ fail: true }), SHOP, { ...deps(), now: () => now });
    const gateAdmin = fakeAdmin({ subs: [sub("Lite")] });
    const r = await checkShopPlanAccess(gateAdmin, SHOP, "sales_summary", { ...deps(), now: () => now });
    assert.equal(gateAdmin.calls.length, 1);
    assert.equal(r.allowed, false);
  });
});

describe("Shopify の料金プラン画面の URL", () => {
  test("admin.shopify.com の pricing_plans（app handle は env か pos-receipt）", () => {
    assert.equal(
      buildPricingPlansUrl("demo.myshopify.com", {}),
      "https://admin.shopify.com/store/demo/charges/pos-receipt/pricing_plans"
    );
    assert.equal(
      buildPricingPlansUrl("https://Demo.myshopify.com/", { SHOPIFY_APP_HANDLE: "pos-receipt-1" }),
      "https://admin.shopify.com/store/demo/charges/pos-receipt-1/pricing_plans"
    );
    assert.equal(buildPricingPlansUrl("", {}), null);
    assert.equal(buildPricingPlansUrl("example.com", {}), null);
    assert.equal(getPublicAppHandle({ SHOPIFY_APP_HANDLE: "  " }), "pos-receipt");
  });
});
