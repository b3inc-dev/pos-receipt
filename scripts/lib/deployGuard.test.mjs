/**
 * Phase 2 — 公開/自社デプロイガードの純関数テスト
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAppModeEquals,
  validateAppDistributionValue,
  validateAppUrlAgainstDistribution,
  validateServerStartupEnv,
} from "./deployGuard.mjs";

describe("validateAppDistributionValue", () => {
  it("未設定・public・inhouse を許可し typo を拒否する", () => {
    assert.equal(validateAppDistributionValue(undefined).ok, true);
    assert.equal(validateAppDistributionValue("").ok, true);
    assert.equal(validateAppDistributionValue("INHOUSE").distribution, "inhouse");
    assert.equal(validateAppDistributionValue("inhose").ok, false);
  });
});

describe("validateAppUrlAgainstDistribution", () => {
  it("既知ホストの取り違えを検出する", () => {
    const bad = validateAppUrlAgainstDistribution(
      "https://pos-receipt.onrender.com",
      "inhouse",
    );
    assert.equal(bad.ok, false);
    const ok = validateAppUrlAgainstDistribution(
      "https://pos-receipt-ciara.onrender.com",
      "inhouse",
    );
    assert.equal(ok.ok, true);
  });

  it("独自ドメインはホスト照合をスキップする", () => {
    const r = validateAppUrlAgainstDistribution("https://example.com", "inhouse");
    assert.equal(r.ok, true);
    assert.ok(r.warnings.length > 0);
  });
});

describe("assertAppModeEquals / validateServerStartupEnv", () => {
  it("APP_MODE ソースを検証する", () => {
    const src = 'const APP_MODE = "public"; // comment\n';
    assert.equal(assertAppModeEquals("public", src).ok, true);
    assert.equal(assertAppModeEquals("inhouse", src).ok, false);
  });

  it("SKIP_DISTRIBUTION_GUARD=1 で起動ガードをスキップする", () => {
    const r = validateServerStartupEnv({
      SKIP_DISTRIBUTION_GUARD: "1",
      APP_DISTRIBUTION: "inhose",
      SHOPIFY_APP_URL: "https://pos-receipt.onrender.com",
    });
    assert.equal(r.ok, true);
  });
});
