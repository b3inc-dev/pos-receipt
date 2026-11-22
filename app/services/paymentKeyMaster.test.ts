/**
 * 支払方法の分け方（「精算の数え方」の paymentKeySource）の試験。
 * - 初めの値（決まった分け方）は今の精算と同じ数字（gasNormalizeGatewayLabel）
 * - 「支払方法マスタで分ける」は、当たったマスタの表示名の行に入れ、現金の上限・商品券のおつりはマスタの種類で効く
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateGasStyleForOrders,
  builtinPaymentKeyResolver,
  DEFAULT_GAS_AGGREGATE_CALC_OPTS,
  gasNormalizeGatewayLabel,
  type GasAggregateCalcOpts,
  type GasStyleOrder,
} from "./settlementAggregatePure.server";
import {
  comparePaymentKeysForMasters,
  createMasterPaymentKeyResolver,
  paymentKeyResolverFor,
  type PaymentKeyMaster,
} from "./paymentKeyMasterPure.server";
import {
  applySpecialRefundEventsToTotals,
  findPaymentSectionIndex,
} from "./specialRefundOverlayPure.server";
import { resolvePaymentSectionLabel } from "../utils/paymentMethodMatch.server";
import {
  DEFAULT_SETTLEMENT_CALC_SETTINGS,
  resolveSettlementCalcSettings,
  validateSettlementCalcSettings,
} from "../utils/settlementCalcSettings";

const inDay = (_iso?: string) => true;

function money(amount: number | string) {
  return { shopMoney: { amount: String(amount), currencyCode: "JPY" } };
}

function tx(id: string, kind: string, amount: number, gateway: string, formattedGateway: string | null = null) {
  return { id, createdAt: "2026-11-22T01:00:00Z", kind, amountSet: money(amount), gateway, formattedGateway };
}

function order(overrides: Partial<GasStyleOrder> & { id: string }): GasStyleOrder {
  return {
    note: null,
    cancelledAt: null,
    totalPriceSet: money(1000),
    totalTaxSet: { shopMoney: { amount: "0" } },
    lineItems: { nodes: [{ quantity: 1 }] },
    transactions: [],
    refunds: [],
    retailLocation: { id: "gid://shopify/Location/100" },
    ...overrides,
  };
}

function calc(patch: Partial<GasAggregateCalcOpts> = {}): GasAggregateCalcOpts {
  return { ...DEFAULT_GAS_AGGREGATE_CALC_OPTS, ...patch };
}

const MASTERS: PaymentKeyMaster[] = [
  { rawGatewayPattern: "cash", matchType: "exact_match", displayLabel: "現金（レジ）", category: "cash" },
  { rawGatewayPattern: "paidy", matchType: "exact_match", displayLabel: "あと払い（Paidy）", category: "uncategorized" },
  { rawGatewayPattern: "PayPay", matchType: "contains_match", displayLabel: "PayPay", category: "qr" },
  {
    rawGatewayPattern: "館内券",
    matchType: "contains_match",
    displayLabel: "館内券",
    category: "voucher",
    isVoucher: true,
  },
  { rawGatewayPattern: "off", matchType: "exact_match", displayLabel: "使わない", enabled: false },
];

describe("決まった分け方（初めの値）", () => {
  it("resolver のキーは gasNormalizeGatewayLabel と同じ", () => {
    const samples: [string, string | null][] = [
      ["cash", "Cash"],
      ["shopify_payments", "Shopify Payments"],
      ["gift_card", "Gift card"],
      ["商品券（釣有り）", null],
      ["paidy", null],
      ["PayPay", "PayPay"],
      ["Suica", null],
      ["", null],
    ];
    for (const [g, f] of samples) {
      assert.equal(builtinPaymentKeyResolver(g, f).key, gasNormalizeGatewayLabel(g, f));
    }
    assert.equal(builtinPaymentKeyResolver("cash").kind, "cash");
    assert.equal(builtinPaymentKeyResolver("gift_card").kind, "voucher");
    assert.equal(builtinPaymentKeyResolver("shopify_payments").kind, "other");
  });

  it("paymentKey を渡さないときと決まった分け方を渡したときで同じ結果", () => {
    const orders = [
      order({
        id: "o1",
        totalPriceSet: money(1500),
        note: "商品券 2000円",
        transactions: [tx("a", "SALE", 1000, "gift_card"), tx("b", "SALE", 1000, "cash")],
      }),
      order({ id: "o2", transactions: [tx("c", "SALE", 1000, "paidy"), tx("d", "REFUND", 300, "paidy")] }),
    ];
    const a = aggregateGasStyleForOrders(structuredClone(orders), inDay, undefined, undefined, calc());
    const b = aggregateGasStyleForOrders(
      structuredClone(orders),
      inDay,
      undefined,
      undefined,
      calc({ paymentKey: paymentKeyResolverFor("builtin", MASTERS) }),
    );
    assert.deepEqual(a, b);
    // 決まった分け方では paidy は「id」を含むので電子マネーになる（マスタで分けると直せる例）
    assert.ok(a.pay["電子マネー"]);
  });

  it("保存していない店・古い保存の値は決まった分け方", () => {
    assert.equal(DEFAULT_SETTLEMENT_CALC_SETTINGS.paymentKeySource, "builtin");
    assert.equal(resolveSettlementCalcSettings(null).paymentKeySource, "builtin");
    assert.equal(resolveSettlementCalcSettings({ saleDateBasis: "order" }).paymentKeySource, "builtin");
    assert.equal(resolveSettlementCalcSettings({ paymentKeySource: "x" }).paymentKeySource, "builtin");
    assert.equal(resolveSettlementCalcSettings({ paymentKeySource: "master" }).paymentKeySource, "master");
  });
});

describe("支払方法マスタで分ける", () => {
  const resolver = createMasterPaymentKeyResolver(MASTERS);

  it("当たったマスタの表示名がキー。当たらなければ決まった分け方。無効のマスタは見ない", () => {
    assert.deepEqual(resolver("cash", "Cash"), { key: "現金（レジ）", kind: "cash" });
    assert.deepEqual(resolver("paidy"), { key: "あと払い（Paidy）", kind: "other" });
    assert.deepEqual(resolver("PayPay（QR）"), { key: "PayPay", kind: "other" });
    assert.deepEqual(resolver("館内券A"), { key: "館内券", kind: "voucher" });
    assert.deepEqual(resolver("shopify_payments"), { key: gasNormalizeGatewayLabel("shopify_payments"), kind: "other" });
    assert.deepEqual(resolver("gift_card"), { key: "商品券", kind: "voucher" });
    assert.equal(resolver("off").key, gasNormalizeGatewayLabel("off"));
  });

  it("formattedGatewayPattern は formattedGateway に当てる", () => {
    const r = createMasterPaymentKeyResolver([
      {
        rawGatewayPattern: "zzz-not-used",
        formattedGatewayPattern: "楽天ペイ",
        matchType: "contains_match",
        displayLabel: "楽天ペイ",
        category: "qr",
      },
    ]);
    assert.equal(r("custom_x", "楽天ペイ（QR）").key, "楽天ペイ");
    assert.equal(r("custom_x", "別の決済").key, gasNormalizeGatewayLabel("custom_x", "別の決済"));
  });

  it("種類が未分類のマスタは、現金・商品券の判定を決まった分け方から引き継ぐ", () => {
    const r = createMasterPaymentKeyResolver([
      { rawGatewayPattern: "cash", matchType: "exact_match", displayLabel: "現金", category: "uncategorized" },
    ]);
    assert.deepEqual(r("cash"), { key: "現金", kind: "cash" });
  });

  it("現金の上限（おつり）は種類が現金のマスタの行に効く", () => {
    const orders = [
      order({
        id: "o1",
        totalPriceSet: money(1200),
        transactions: [tx("a", "SALE", 1000, "PayPay"), tx("b", "SALE", 500, "cash")],
      }),
    ];
    const r = aggregateGasStyleForOrders(orders, inDay, undefined, undefined, calc({ paymentKey: resolver }));
    assert.equal(r.pay["現金（レジ）"].sale, 200);
    assert.equal(r.pay["PayPay"].sale, 1000);
    assert.equal(r.pay["現金"], undefined);
  });

  it("現金の種類の行が 2 つでも、上限は合わせて 1 回だけ（並んだ順に削る）", () => {
    const r2 = createMasterPaymentKeyResolver([
      { rawGatewayPattern: "cash", matchType: "exact_match", displayLabel: "現金A", category: "cash" },
      { rawGatewayPattern: "manual", matchType: "exact_match", displayLabel: "現金B", category: "cash" },
    ]);
    const orders = [
      order({
        id: "o1",
        totalPriceSet: money(1000),
        transactions: [tx("a", "SALE", 600, "cash"), tx("b", "SALE", 600, "manual")],
      }),
    ];
    const r = aggregateGasStyleForOrders(orders, inDay, undefined, undefined, calc({ paymentKey: r2 }));
    assert.equal(r.pay["現金A"].sale + r.pay["現金B"].sale, 1000);
    assert.equal(r.pay["現金A"].sale, 400);
    assert.equal(r.pay["現金B"].sale, 600);
    assert.equal(r.voucherChangeObserved, 0);
  });

  it("商品券として扱うマスタは、ノートの額面からおつりを見る対象になる", () => {
    const orders = [
      order({
        id: "o1",
        note: "商品券 3000円",
        totalPriceSet: money(2500),
        transactions: [tx("a", "SALE", 2500, "館内券")],
      }),
    ];
    const r = aggregateGasStyleForOrders(orders, inDay, undefined, undefined, calc({ paymentKey: resolver }));
    assert.equal(r.pay["館内券"].sale, 2500);
    assert.equal(r.voucherChangeObserved, 500);
  });

  it("返金も同じ行に入り、付け替えの決まりは行の名前に当てる", () => {
    const orders = [
      order({ id: "o1", transactions: [tx("a", "SALE", 1000, "paidy"), tx("b", "REFUND", 400, "paidy")] }),
    ];
    const r = aggregateGasStyleForOrders(
      orders,
      inDay,
      undefined,
      undefined,
      calc({ paymentKey: resolver, refundRemapRules: [{ match: "あと払い", toLabel: "現金（レジ）", locationId: "" }] }),
    );
    assert.equal(r.pay["あと払い（Paidy）"].sale, 1000);
    assert.equal(r.pay["あと払い（Paidy）"].refund, 0);
    assert.equal(r.pay["現金（レジ）"].refund, 400);
  });

  it("表示名: キーがマスタの表示名そのものなら、ほかのマスタの contains に先に当たらない", () => {
    const masters = [
      { rawGatewayPattern: "pay", matchType: "contains_match", displayLabel: "その他の pay" },
      { rawGatewayPattern: "PayPay", matchType: "exact_match", displayLabel: "PayPay" },
    ];
    assert.equal(resolvePaymentSectionLabel("PayPay", masters), "その他の pay");
    assert.equal(resolvePaymentSectionLabel("PayPay", masters, { preferExactDisplayLabel: true }), "PayPay");
  });

  it("特殊返金の手段（マスタの gateway の名前）を行の名前に直して探す", () => {
    const sections = () => [
      { gateway: "現金（レジ）", label: "現金（レジ）", net: 5000, refund: 0, txCount: 2, refundCount: 0 },
      { gateway: "あと払い（Paidy）", label: "あと払い（Paidy）", net: 3000, refund: 1000, txCount: 1, refundCount: 1 },
    ];
    const resolveKey = (m: string) => resolver(m, null).key;
    // マスタを使わない探し方でも、ここは「電子マネー」どうしの偶然の一致で当たる（決まった分け方の二重の例）
    assert.equal(findPaymentSectionIndex(sections(), "paidy"), 1);
    assert.equal(findPaymentSectionIndex(sections(), "PayPay"), -1);
    assert.equal(findPaymentSectionIndex(sections(), "paidy", resolveKey), 1);

    const s = sections();
    const totals = { total: 8000, refundTotal: 1000 };
    applySpecialRefundEventsToTotals(
      s,
      [
        {
          eventType: "payment_method_override",
          amount: 1000,
          originalPaymentMethod: "paidy",
          actualRefundMethod: "cash",
          adjustKind: null,
          shopifyRefundStatus: "success",
        },
      ],
      totals,
      { resolveKey },
    );
    assert.equal(s[1].refund, 0);
    assert.equal(s[0].refund, 1000);
    assert.equal(s.length, 2);
  });

  it("切り替える前の対応表: 行の名前が変わるマスタだけ changes", () => {
    const rows = comparePaymentKeysForMasters(MASTERS);
    const byGw = Object.fromEntries(rows.map((r) => [r.rawGatewayPattern, r]));
    assert.equal(byGw["cash"].builtinKey, "現金");
    assert.equal(byGw["cash"].masterKey, "現金（レジ）");
    assert.equal(byGw["cash"].changes, true);
    assert.equal(byGw["PayPay"].changes, false);
    assert.equal(byGw["off"], undefined);
  });

  it("画面から来た値: 無ければ初めの値、知らない値は保存しない", () => {
    const base = {
      saleDateBasis: "transaction",
      giftCardRefundEnabled: false,
      giftCardRefundLabel: "現金",
      itemCountExcludedSkus: "",
      refundRemapRules: [],
      paymentTxCountMode: "sales",
      clampTotalAtZero: true,
    };
    const o = { legacyGiftCardAggregationEnabled: false };
    const none = validateSettlementCalcSettings(base, o);
    assert.ok(none.ok && none.settings.paymentKeySource === "builtin");
    const master = validateSettlementCalcSettings({ ...base, paymentKeySource: "master" }, o);
    assert.ok(master.ok && master.settings.paymentKeySource === "master");
    assert.equal(validateSettlementCalcSettings({ ...base, paymentKeySource: "x" }, o).ok, false);
  });
});
