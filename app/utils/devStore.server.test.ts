import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEV_ONLY_GENERAL_SETTING_KEYS,
  isDevelopmentStore,
  keepDevOnlySettings,
  requireDevelopmentStore,
} from "./devStore.server";

function adminReturning(body: unknown) {
  return { graphql: async () => new Response(JSON.stringify(body)) };
}

describe("isDevelopmentStore", () => {
  it("partnerDevelopment が true の店だけ true", async () => {
    assert.equal(await isDevelopmentStore(adminReturning({ data: { shop: { plan: { partnerDevelopment: true } } } })), true);
  });

  it("partnerDevelopment が false の店は false", async () => {
    assert.equal(await isDevelopmentStore(adminReturning({ data: { shop: { plan: { partnerDevelopment: false } } } })), false);
  });

  it("true 以外の値（文字の \"true\"・null・欠け）は false", async () => {
    assert.equal(await isDevelopmentStore(adminReturning({ data: { shop: { plan: { partnerDevelopment: "true" } } } })), false);
    assert.equal(await isDevelopmentStore(adminReturning({ data: { shop: { plan: null } } })), false);
    assert.equal(await isDevelopmentStore(adminReturning({ data: null, errors: [{ message: "Access denied" }] })), false);
  });

  it("通信の失敗・JSON でない返事は false", async () => {
    assert.equal(await isDevelopmentStore({ graphql: async () => { throw new Error("network"); } }), false);
    assert.equal(await isDevelopmentStore({ graphql: async () => new Response("<html>502</html>") }), false);
  });
});

describe("keepDevOnlySettings", () => {
  const saved = {
    appDisplayName: "前",
    debugModeEnabled: false,
    diagnosticsPanelEnabled: true,
    verboseCalcLogEnabled: false,
    currentPlanCode: "lite",
    enabledFeaturesJson: "{}",
  };
  const next = {
    appDisplayName: "後",
    debugModeEnabled: true,
    diagnosticsPanelEnabled: false,
    verboseCalcLogEnabled: true,
    currentPlanCode: "pro",
    enabledFeaturesJson: '{"x":true}',
  };

  it("プラン（表示用）・有効機能 JSON（表示用）も開発ストアだけの欄", () => {
    assert.ok(DEV_ONLY_GENERAL_SETTING_KEYS.includes("currentPlanCode"));
    assert.ok(DEV_ONLY_GENERAL_SETTING_KEYS.includes("enabledFeaturesJson"));
  });

  it("開発ストアでは送られた値で保存する", () => {
    assert.deepEqual(keepDevOnlySettings(next, saved, true), next);
  });

  it("開発ストアでない店では、デバッグの欄だけ保存済みの値のまま（ほかの欄は送られた値）", () => {
    const result = keepDevOnlySettings(next, saved, false);
    assert.equal(result.appDisplayName, "後");
    for (const key of DEV_ONLY_GENERAL_SETTING_KEYS) assert.equal(result[key], saved[key]);
  });
});

describe("requireDevelopmentStore", () => {
  it("開発ストアなら通す", async () => {
    await requireDevelopmentStore(adminReturning({ data: { shop: { plan: { partnerDevelopment: true } } } }));
  });

  it("開発ストアでない・読めないときは 404 を投げる", async () => {
    for (const admin of [
      adminReturning({ data: { shop: { plan: { partnerDevelopment: false } } } }),
      adminReturning({ errors: [{ message: "Access denied" }] }),
      { graphql: async () => { throw new Error("network"); } },
    ]) {
      await assert.rejects(requireDevelopmentStore(admin), (e: unknown) => e instanceof Response && e.status === 404);
    }
  });
});
