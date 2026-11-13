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
  validateTomlAppModeMapping,
  readApplicationUrlFromToml,
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

describe("validateTomlAppModeMapping（toml↔mode 対応）", () => {
  it("application_url を toml から読む", () => {
    assert.equal(
      readApplicationUrlFromToml('application_url = "https://pos-receipt.onrender.com"\n'),
      "https://pos-receipt.onrender.com",
    );
  });

  it("正しい public/inhouse 対応を許可する", () => {
    const r = validateTomlAppModeMapping({
      publicToml: 'application_url = "https://pos-receipt.onrender.com"\n',
      inhouseToml: 'application_url = "https://pos-receipt-ciara.onrender.com"\n',
      appUrlJs: `
        const PROD_APP_URL_PUBLIC = "https://pos-receipt.onrender.com";
        const PROD_APP_URL_INHOUSE = "https://pos-receipt-ciara.onrender.com";
        const APP_MODE = "inhouse";
      `,
    });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("toml ホスト取り違えを拒否する", () => {
    const r = validateTomlAppModeMapping({
      publicToml: 'application_url = "https://pos-receipt-ciara.onrender.com"\n',
      inhouseToml: 'application_url = "https://pos-receipt.onrender.com"\n',
      appUrlJs: `
        const PROD_APP_URL_PUBLIC = "https://pos-receipt.onrender.com";
        const PROD_APP_URL_INHOUSE = "https://pos-receipt-ciara.onrender.com";
      `,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 2);
  });
});
