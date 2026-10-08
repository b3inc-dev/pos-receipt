/**
 * Phase 2 — 決済名称解決（マスタマッチ）の純関数テスト
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchPaymentMethodMaster,
  resolvePaymentSectionLabel,
  type PaymentMethodMatchInput,
} from "./paymentMethodMatch.server";

const masters: PaymentMethodMatchInput[] = [
  {
    rawGatewayPattern: "cash",
    formattedGatewayPattern: "現金",
    matchType: "exact_match",
    displayLabel: "店頭現金",
  },
  {
    rawGatewayPattern: "custom_paypay",
    formattedGatewayPattern: null,
    matchType: "contains_match",
    displayLabel: "PayPay（店頭）",
  },
  {
    rawGatewayPattern: "gift_card",
    formattedGatewayPattern: "商品券",
    matchType: "exact_match",
    displayLabel: "自社商品券",
    isVoucher: true,
  },
];

describe("matchPaymentMethodMaster / resolvePaymentSectionLabel", () => {
  it("英数字 raw gateway をマスタ displayLabel に差し替える", () => {
    assert.equal(resolvePaymentSectionLabel("cash", masters), "店頭現金");
    assert.equal(matchPaymentMethodMaster("cash", masters)?.displayLabel, "店頭現金");
  });

  it("GAS 日本語バケットキー（formatted / displayLabel）でもマスタに一致する", () => {
    assert.equal(resolvePaymentSectionLabel("現金", masters), "店頭現金");
    assert.equal(resolvePaymentSectionLabel("商品券", masters), "自社商品券");
    assert.equal(resolvePaymentSectionLabel("店頭現金", masters), "店頭現金");
  });

  it("カスタム gateway の contains マッチが効く", () => {
    assert.equal(resolvePaymentSectionLabel("custom_paypay_pos", masters), "PayPay（店頭）");
  });

  it("未一致はフォールバックまたはキーそのまま", () => {
    assert.equal(resolvePaymentSectionLabel("shopify_payments", masters), "クレジットカード");
    assert.equal(resolvePaymentSectionLabel("未知の決済", masters), "未知の決済");
  });
});
