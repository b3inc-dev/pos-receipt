/**
 * 精算の「ポイント利用額」に数える割引の見分け方。合成データのみ。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_POINT_REDEMPTION_RULES,
  isPointRedemption,
  resolvePointRedemptionRules,
  validatePointRedemptionRules,
} from "./pointRedemptionRules";

describe("DEFAULT_POINT_REDEMPTION_RULES", () => {
  it("初めの値に VIP-・SP-POINT-・旧形式・POS の Shop Point が入る", () => {
    assert.deepEqual(DEFAULT_POINT_REDEMPTION_RULES.codePrefixes, ["VIP-", "SP-POINT-"]);
    assert.deepEqual(DEFAULT_POINT_REDEMPTION_RULES.manualTitles, ["Shop Point"]);
    assert.equal(DEFAULT_POINT_REDEMPTION_RULES.legacyShopPointHexCode, true);
  });
});

describe("isPointRedemption", () => {
  it("初めの値で数えるもの・数えないもの", () => {
    assert.equal(isPointRedemption("SP-POINT-AB12CD34", ""), true);
    assert.equal(isPointRedemption("VIP-123", ""), true);
    assert.equal(isPointRedemption("SP0123456789abcdef", ""), true);
    assert.equal(isPointRedemption("SPOINT", ""), false);
    assert.equal(isPointRedemption("SP-POINTX", ""), false);
    assert.equal(isPointRedemption("", "shop point"), true);
    assert.equal(isPointRedemption("", "スタッフ割引"), false);
  });

  it("旧形式を切ると SP + 16 進は数えない", () => {
    const rules = { ...DEFAULT_POINT_REDEMPTION_RULES, legacyShopPointHexCode: false };
    assert.equal(isPointRedemption("SP0123456789abcdef", "", rules), false);
    assert.equal(isPointRedemption("SP-POINT-AB12CD34", "", rules), true);
  });
});

describe("validatePointRedemptionRules", () => {
  it("行・カンマで分け、大文字にそろえ、重なりを除く", () => {
    const r = validatePointRedemptionRules({
      codePrefixes: "vip-\nSP-POINT-, sp-point-",
      manualTitles: "Shop Point\nshop point\n",
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.rules.codePrefixes, ["VIP-", "SP-POINT-"]);
    assert.deepEqual(r.rules.manualTitles, ["Shop Point"]);
    assert.equal(r.rules.legacyShopPointHexCode, true);
  });

  it("空・ハイフンで終わらない・短すぎる頭は受け付けない", () => {
    assert.equal(validatePointRedemptionRules({ codePrefixes: "" }).ok, false);
    assert.equal(validatePointRedemptionRules({ codePrefixes: "VIP" }).ok, false);
    assert.equal(validatePointRedemptionRules({ codePrefixes: "S-" }).ok, false);
    assert.equal(validatePointRedemptionRules({ codePrefixes: "SP_POINT-" }).ok, false);
  });
});

describe("resolvePointRedemptionRules", () => {
  it("保存していない店は初めの値", () => {
    assert.deepEqual(resolvePointRedemptionRules(null), DEFAULT_POINT_REDEMPTION_RULES);
    assert.deepEqual(
      resolvePointRedemptionRules({ loyaltyUsageDisplayLabel: "ポイント" } as never),
      DEFAULT_POINT_REDEMPTION_RULES,
    );
  });

  it("保存値を使う。名前は空にできる", () => {
    const r = resolvePointRedemptionRules({
      pointRedemptionCodePrefixes: ["VIP-", "PT-"],
      pointRedemptionManualTitles: [],
      pointRedemptionLegacyShopPointHexCode: false,
    });
    assert.deepEqual(r, { codePrefixes: ["VIP-", "PT-"], manualTitles: [], legacyShopPointHexCode: false });
  });

  it("保存値が壊れていたら初めの値に戻す（精算を止めない）", () => {
    const r = resolvePointRedemptionRules({ pointRedemptionCodePrefixes: ["VIP"] });
    assert.deepEqual(r, DEFAULT_POINT_REDEMPTION_RULES);
  });
});
