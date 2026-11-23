// 2026-11-22 T の決定: (1) 未契約の店を止める（POS Stock と同じ・スイッチ PLAN_REQUIRE_SUBSCRIPTION、既定オフ）
// (2) 超えたロケーションは「POS で使うロケーション」だけを数える。合成データだけを使う。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  __clearShopPlanCacheForTest,
  checkSubscriptionGate,
  countPosLocations,
  getShopPlan,
  isSubscriptionRequired,
  PLAN_REQUIRED_MESSAGE,
  POS_LOCATION_WINDOW_DAYS,
  shouldBlockForNoSubscription,
} from "../app/utils/shopPlan.server.ts";

const SHOP = { id: "s1", shopDomain: "demo.myshopify.com", planCode: "lite" };
const GID = "gid://shopify/Shop/12345678";
const PERIOD = "2099-12-21T00:00:00Z";
const loc = (i) => `gid://shopify/Location/${i}`;
const sub = (name) => ({ id: `gid://shopify/AppSubscription/${name}`, name, status: "ACTIVE", currentPeriodEnd: PERIOD });

function fakeAdmin({ subs = [], locations = 1, dev = false, fail = false } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async graphql() {
      calls += 1;
      if (fail) throw new Error("graphql down");
      return {
        json: async () => ({
          data: {
            shop: { id: GID, plan: { partnerDevelopment: dev } },
            locations: { nodes: Array.from({ length: locations }, (_, i) => ({ id: loc(i) })) },
            currentAppInstallation: { activeSubscriptions: subs },
          },
        }),
      };
    },
  };
}

function deps(over = {}) {
  const reports = [];
  return {
    reports,
    env: {},
    savePlanCode: async () => {},
    getUsageStore: async () => ({}),
    listUsedLocationIds: async () => [],
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

describe("POS で使うロケーションだけを数える", () => {
  test("直近に使った ID のうち、今有効なロケーションだけ・重なりなし", () => {
    assert.equal(countPosLocations([loc(0), loc(1), loc(1), loc(9)], [loc(0), loc(1), loc(2)]), 2);
    assert.equal(countPosLocations([], [loc(0)]), 0);
    assert.equal(POS_LOCATION_WINDOW_DAYS, 30);
  });

  test("Lite で有効なロケーションが 8 か所でも、POS で使ったのが 5 か所なら超えた分は 2 か所（報告も 5 か所）", async () => {
    let askedSince = null;
    const d = deps({
      now: () => Date.parse("2026-12-01T00:00:00Z"),
      listUsedLocationIds: async (shopId, since) => {
        assert.equal(shopId, "s1");
        askedSince = since;
        return [loc(0), loc(1), loc(2), loc(3), loc(4), loc(4)];
      },
    });
    const s = await getShopPlan(fakeAdmin({ subs: [sub("Lite")], locations: 8 }), SHOP, d);
    assert.equal(s.locationsCount, 8);
    assert.equal(s.posLocationsCount, 5);
    assert.equal(s.extraLocationUsage?.units, 2);
    assert.equal(s.extraLocationStatus, "counted");
    assert.equal(askedSince.toISOString(), "2026-11-01T00:00:00.000Z");
    await flush();
    assert.equal(d.reports.length, 1);
    assert.equal(d.reports[0].locationsCount, 5);
  });

  test("POS で使ったのが 3 か所までなら報告しない（範囲内）", async () => {
    const d = deps({ listUsedLocationIds: async () => [loc(0), loc(1), loc(2)] });
    const s = await getShopPlan(fakeAdmin({ subs: [sub("Lite")], locations: 20 }), SHOP, d);
    assert.equal(s.posLocationsCount, 3);
    assert.equal(s.extraLocationStatus, "within_plan");
    await flush();
    assert.equal(d.reports.length, 0);
  });

  test("DB を読めなければ数えず報告しない（count_failed）。getShopPlan は投げない", async () => {
    const d = deps({
      listUsedLocationIds: async () => {
        throw new Error("db down");
      },
    });
    const s = await getShopPlan(fakeAdmin({ subs: [sub("Lite")], locations: 20 }), SHOP, d);
    assert.equal(s.posLocationsCount, null);
    assert.equal(s.extraLocationStatus, "count_failed");
    assert.equal(s.extraLocationUsage, undefined);
    await flush();
    assert.equal(d.reports.length, 0);
  });

  test("契約なし・全機能の例外では DB を数えに行かない", async () => {
    let asked = 0;
    const count = async () => {
      asked += 1;
      return [];
    };
    await getShopPlan(fakeAdmin({ subs: [], locations: 9 }), SHOP, deps({ listUsedLocationIds: count }));
    await getShopPlan(fakeAdmin({ subs: [sub("Lite")], locations: 9, dev: true }), SHOP, deps({ listUsedLocationIds: count }));
    assert.equal(asked, 0);
  });
});

describe("未契約の店を止める（PLAN_REQUIRE_SUBSCRIPTION）", () => {
  const on = { PLAN_REQUIRE_SUBSCRIPTION: "1" };
  const base = { distribution: "public", fullAccess: false, subscriptionsRead: true, plan: null, planCode: "lite" };

  test("スイッチは \"1\" のときだけオン（既定オフ）", () => {
    assert.equal(isSubscriptionRequired({}), false);
    for (const v of ["", "0", "true", "yes"]) assert.equal(isSubscriptionRequired({ PLAN_REQUIRE_SUBSCRIPTION: v }), false, v);
    assert.equal(isSubscriptionRequired(on), true);
  });

  test("止めるのは、公開用・例外でない・契約を読めて有効な契約が無い・unlimited でない店だけ", () => {
    assert.equal(shouldBlockForNoSubscription(base, on), true);
    assert.equal(shouldBlockForNoSubscription(base, {}), false, "スイッチオフ");
    assert.equal(shouldBlockForNoSubscription({ ...base, subscriptionsRead: false }, on), false, "読めなかったら止めない");
    assert.equal(shouldBlockForNoSubscription({ ...base, plan: "lite" }, on), false);
    assert.equal(shouldBlockForNoSubscription({ ...base, plan: "pro", planCode: "pro" }, on), false);
    assert.equal(shouldBlockForNoSubscription({ ...base, fullAccess: true }, on), false, "開発ストア・CUSTOM");
    assert.equal(shouldBlockForNoSubscription({ ...base, distribution: "inhouse" }, on), false, "自社用");
    assert.equal(shouldBlockForNoSubscription({ ...base, planCode: "unlimited" }, on), false);
  });

  test("checkSubscriptionGate: スイッチオフと自社用は Shopify に聞かない", async () => {
    const admin = fakeAdmin({ subs: [] });
    assert.deepEqual(await checkSubscriptionGate(admin, SHOP, deps()), { blocked: false, state: null });
    process.env.APP_DISTRIBUTION = "inhouse";
    assert.deepEqual(await checkSubscriptionGate(admin, SHOP, deps({ env: on })), { blocked: false, state: null });
    assert.equal(admin.calls, 0);
  });

  test("checkSubscriptionGate: 未契約は止める・契約ありと読めないは通す・60 秒は覚えを使う", async () => {
    const none = fakeAdmin({ subs: [] });
    assert.equal((await checkSubscriptionGate(none, SHOP, deps({ env: on }))).blocked, true);
    assert.equal((await checkSubscriptionGate(none, SHOP, deps({ env: on }))).blocked, true);
    assert.equal(none.calls, 1, "2 回目は覚えを使う");
    __clearShopPlanCacheForTest();
    assert.equal((await checkSubscriptionGate(fakeAdmin({ subs: [sub("Lite")] }), SHOP, deps({ env: on }))).blocked, false);
    __clearShopPlanCacheForTest();
    assert.equal((await checkSubscriptionGate(fakeAdmin({ fail: true }), SHOP, deps({ env: on }))).blocked, false);
    __clearShopPlanCacheForTest();
    assert.equal((await checkSubscriptionGate(fakeAdmin({ subs: [], dev: true }), SHOP, deps({ env: on }))).blocked, false);
  });

  test("POS の API と管理画面のレイアウトで止める。料金プラン画面は開ける", () => {
    const pos = readFileSync("app/utils/posAuth.server.ts", "utf8");
    assert.match(pos, /checkSubscriptionGate\(admin, shop\)/);
    assert.match(pos, /code: "PLAN_REQUIRED" \}, \{ status: 402 \}/);
    const layout = readFileSync("app/routes/app.tsx", "utf8");
    assert.match(layout, /if \(!isInhouseMode\(\) && isSubscriptionRequired\(\)\)/);
    assert.match(layout, /if \(!isPlanPath\(url\.pathname\)\)/);
    assert.match(layout, /throw redirect\(`\/app\/plan\$\{url\.search\}`\)/);
    assert.match(PLAN_REQUIRED_MESSAGE, /料金プラン/);
  });
});
