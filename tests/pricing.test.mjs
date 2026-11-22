import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BILLING_PLANS,
  EXTRA_LOCATION_PRICE_USD,
  PLAN_FEATURES,
  planLabel,
} from "../app/utils/planFeatures.server.ts";
import {
  EXTRA_LOCATION_PRICE_USD as USAGE_PRICE_USD,
  INCLUDED_LOCATIONS,
  computeExtraLocationUsage,
  isUsageReportingEnabled,
} from "../app/utils/appEventsUsage.server.ts";

// 公開用の料金（2026-11-22 T が確定）: Lite $100/月・Pro $200/月・超えた 1 か所 +$20/月。
// 数を変えるときは T の決定と Partner Dashboard の App Pricing も一緒に変える。

describe("公開用の料金（確定）", () => {
  test("Lite は $100/月・3 ロケーションまで", () => {
    assert.equal(BILLING_PLANS.lite.amount, 100);
    assert.equal(BILLING_PLANS.lite.currencyCode, "USD");
    assert.equal(BILLING_PLANS.lite.planCode, "lite");
    assert.equal(BILLING_PLANS.lite.maxLocations, 3);
    assert.equal(BILLING_PLANS.lite.name, "Liteプラン");
  });

  test("Pro は $200/月・10 ロケーションまで", () => {
    assert.equal(BILLING_PLANS.pro.amount, 200);
    assert.equal(BILLING_PLANS.pro.currencyCode, "USD");
    assert.equal(BILLING_PLANS.pro.planCode, "pro");
    assert.equal(BILLING_PLANS.pro.maxLocations, 10);
    assert.equal(BILLING_PLANS.pro.name, "Proプラン");
  });

  test("プランは Lite と Pro の 2 つだけ", () => {
    assert.deepEqual(Object.keys(BILLING_PLANS).sort(), ["lite", "pro"]);
    assert.deepEqual(Object.keys(PLAN_FEATURES).sort(), ["lite", "pro"]);
    const saved = process.env.APP_DISTRIBUTION;
    try {
      delete process.env.APP_DISTRIBUTION;
      assert.equal(planLabel("lite"), "Liteプラン");
      assert.equal(planLabel("standard"), "Liteプラン");
      assert.equal(planLabel("pro"), "Proプラン");
      // 自社用（Ciara）は今まで通り無制限の表示（請求なし）
      process.env.APP_DISTRIBUTION = "inhouse";
      assert.equal(planLabel("lite"), "自社用（無制限）");
    } finally {
      if (saved === undefined) delete process.env.APP_DISTRIBUTION;
      else process.env.APP_DISTRIBUTION = saved;
    }
  });

  test("超えた 1 か所は Lite・Pro とも $20/月", () => {
    assert.equal(EXTRA_LOCATION_PRICE_USD, 20);
    assert.deepEqual(USAGE_PRICE_USD, { lite: 20, pro: 20 });
  });

  test("画面の値（planFeatures）と報告の値（appEventsUsage）が同じ", () => {
    for (const plan of ["lite", "pro"]) {
      assert.equal(INCLUDED_LOCATIONS[plan], BILLING_PLANS[plan].maxLocations, plan);
      assert.equal(USAGE_PRICE_USD[plan], EXTRA_LOCATION_PRICE_USD, plan);
    }
  });

  test("月の合計の例: Lite 5 か所 = $100 + 2 × $20、Pro 12 か所 = $200 + 2 × $20", () => {
    const lite = computeExtraLocationUsage("lite", 5);
    assert.equal(BILLING_PLANS.lite.amount + lite.amountUsd, 140);
    const pro = computeExtraLocationUsage("pro", 12);
    assert.equal(BILLING_PLANS.pro.amount + pro.amountUsd, 240);
    assert.equal(computeExtraLocationUsage("lite", 3).amountUsd, 0);
    assert.equal(computeExtraLocationUsage("pro", 10).amountUsd, 0);
  });

  test("超えた分の報告は既定オフ（スイッチが無ければ送らない）", () => {
    assert.equal(isUsageReportingEnabled({}), false);
    assert.equal(isUsageReportingEnabled({ APP_EVENTS_USAGE_ENABLED: "0" }), false);
    assert.equal(isUsageReportingEnabled({ APP_EVENTS_USAGE_ENABLED: "1" }), true);
  });
});
