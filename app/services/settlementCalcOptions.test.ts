/**
 * 「精算の数え方」の設定（app/utils/settlementCalcSettings.ts）が精算の集計に効くかの試験。
 * 初めの値では今の数え方と同じ数字になることも確かめる。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateGasStyleForOrders,
  DEFAULT_GAS_AGGREGATE_CALC_OPTS,
  isItemCountExcludedLine,
  type GasAggregateCalcOpts,
  type GasStyleOrder,
} from "./settlementAggregatePure.server";
import {
  giftCardRefundNoteDate,
  locationNameKey,
  matchGiftCardRefundNote,
  sumGiftCardRefunds,
} from "./settlementGiftCardRefunds.server";
import {
  DEFAULT_SETTLEMENT_CALC_SETTINGS,
  paymentSectionTxCount,
  remapRefundLabel,
  resolveSettlementCalcSettings,
  validateSettlementCalcSettings,
} from "../utils/settlementCalcSettings";

const DAY_START = Date.parse("2026-11-21T15:00:00Z"); // 2026-11-22 00:00 JST
const DAY_END = Date.parse("2026-11-22T14:59:59Z");
const inDay = (iso?: string) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= DAY_START && t <= DAY_END;
};

function money(amount: number | string) {
  return { shopMoney: { amount: String(amount), currencyCode: "JPY" } };
}

function opts(patch: Partial<GasAggregateCalcOpts>): GasAggregateCalcOpts {
  return { ...DEFAULT_GAS_AGGREGATE_CALC_OPTS, ...patch };
}

function order(overrides: Partial<GasStyleOrder> & { id: string }): GasStyleOrder {
  return {
    note: null,
    cancelledAt: null,
    processedAt: "2026-11-22T01:00:00Z",
    totalPriceSet: money(1000),
    totalTaxSet: { shopMoney: { amount: "0" } },
    lineItems: { nodes: [{ quantity: 1 }] },
    transactions: [
      { id: `${overrides.id}-sale`, createdAt: "2026-11-22T01:00:00Z", kind: "SALE", amountSet: money(1000), gateway: "cash" },
    ],
    refunds: [],
    retailLocation: { id: "gid://shopify/Location/100" },
    ...overrides,
  };
}

describe("設定の読み取り", () => {
  it("保存していない店は今の数え方", () => {
    assert.deepEqual(resolveSettlementCalcSettings(null), DEFAULT_SETTLEMENT_CALC_SETTINGS);
    assert.deepEqual(resolveSettlementCalcSettings("壊れた値"), DEFAULT_SETTLEMENT_CALC_SETTINGS);
  });

  it("壊れた値・知らない値は初めの値にし、SKU はそろえて重ねない", () => {
    const s = resolveSettlementCalcSettings({
      saleDateBasis: "x",
      paymentTxCountMode: "sales_minus_refunds",
      itemCountExcludedSkus: [" nov-1 ", "NOV-1", "nov-2"],
      refundRemapRules: [{ match: "wespo", toLabel: "現金", locationId: "gid://shopify/Location/7" }, { match: "", toLabel: "a" }],
      clampTotalAtZero: false,
    });
    assert.equal(s.saleDateBasis, "transaction");
    assert.equal(s.paymentTxCountMode, "sales_minus_refunds");
    assert.deepEqual(s.itemCountExcludedSkus, ["NOV-1", "NOV-2"]);
    assert.deepEqual(s.refundRemapRules, [{ match: "wespo", toLabel: "現金", locationId: "7" }]);
    assert.equal(s.clampTotalAtZero, false);
  });

  const base = {
    saleDateBasis: "transaction",
    giftCardRefundEnabled: false,
    giftCardRefundLabel: "現金",
    itemCountExcludedSkus: "",
    refundRemapRules: [],
    paymentTxCountMode: "sales",
    clampTotalAtZero: true,
  };

  it("旧ギフトカード API 集計が ON のあいだはギフトカードの返金を ON にできない", () => {
    const r = validateSettlementCalcSettings(
      { ...base, giftCardRefundEnabled: true },
      { legacyGiftCardAggregationEnabled: true },
    );
    assert.equal(r.ok, false);
    const ok = validateSettlementCalcSettings(
      { ...base, giftCardRefundEnabled: true },
      { legacyGiftCardAggregationEnabled: false },
    );
    assert.equal(ok.ok, true);
  });

  it("付け替えの行の誤りは行の番号を出し、知らない店は断る。空の行は捨てる", () => {
    const missing = validateSettlementCalcSettings(
      { ...base, refundRemapRules: [{ match: "", toLabel: "", locationId: "" }, { match: "wespo", toLabel: "" }] },
      { legacyGiftCardAggregationEnabled: false },
    );
    assert.equal(missing.ok, false);
    assert.match((missing as { error: string }).error, /2 行目/);
    const unknown = validateSettlementCalcSettings(
      { ...base, refundRemapRules: [{ match: "wespo", toLabel: "現金", locationId: "9" }] },
      { legacyGiftCardAggregationEnabled: false, knownLocationIds: new Set(["7"]) },
    );
    assert.equal(unknown.ok, false);
    const ok = validateSettlementCalcSettings(
      { ...base, refundRemapRules: [{ match: "", toLabel: "" }, { match: "wespo", toLabel: "現金", locationId: "7" }] },
      { legacyGiftCardAggregationEnabled: false, knownLocationIds: new Set(["7"]) },
    );
    assert.equal(ok.ok, true);
    assert.deepEqual((ok as { settings: { refundRemapRules: unknown } }).settings.refundRemapRules, [
      { match: "wespo", toLabel: "現金", locationId: "7" },
    ]);
  });

  it("知らない選択肢は保存しない", () => {
    assert.equal(validateSettlementCalcSettings({ ...base, saleDateBasis: "x" }, { legacyGiftCardAggregationEnabled: false }).ok, false);
    assert.equal(validateSettlementCalcSettings({ ...base, paymentTxCountMode: "x" }, { legacyGiftCardAggregationEnabled: false }).ok, false);
  });
});

describe("売上を数える日", () => {
  // 前日の注文（processedAt は前日）を当日に決済した
  const lateOrder = () =>
    order({
      id: "late",
      processedAt: "2026-11-21T05:00:00Z",
      transactions: [
        { id: "late-sale", createdAt: "2026-11-22T02:00:00Z", kind: "SALE", amountSet: money(1000), gateway: "cash" },
      ],
    });

  it("決済した日（初めの値）: 当日の決済を当日に数える", () => {
    const gas = aggregateGasStyleForOrders([lateOrder()], inDay);
    assert.equal(gas.pay["現金"]?.sale, 1000);
  });

  it("注文の日: 前日の注文の決済は当日に数えない", () => {
    const gas = aggregateGasStyleForOrders([lateOrder()], inDay, undefined, undefined, opts({ saleDateBasis: "order" }));
    assert.equal(gas.pay["現金"]?.sale ?? 0, 0);
    assert.equal(gas.saleOrderSet.size, 0);
  });

  it("注文の日: 当日の注文は翌日に決済しても当日に数える", () => {
    const o = order({
      id: "next",
      transactions: [
        { id: "next-sale", createdAt: "2026-11-23T02:00:00Z", kind: "SALE", amountSet: money(1000), gateway: "credit_card" },
      ],
    });
    assert.equal(aggregateGasStyleForOrders([o], inDay).pay["クレジットカード"]?.sale ?? 0, 0);
    const gas = aggregateGasStyleForOrders([o], inDay, undefined, undefined, opts({ saleDateBasis: "order" }));
    assert.equal(gas.pay["クレジットカード"]?.sale, 1000);
  });

  it("注文の日: 決済が確定していない注文はオーソリを売上に数え、確定後は二重にしない", () => {
    const authOnly = order({
      id: "auth",
      transactions: [
        { id: "auth-1", createdAt: "2026-11-22T01:00:00Z", kind: "AUTHORIZATION", status: "SUCCESS", amountSet: money(1000), gateway: "credit_card" },
      ],
    });
    assert.equal(aggregateGasStyleForOrders([authOnly], inDay).pay["クレジットカード"]?.sale ?? 0, 0);
    const byOrder = opts({ saleDateBasis: "order" });
    assert.equal(aggregateGasStyleForOrders([authOnly], inDay, undefined, undefined, byOrder).pay["クレジットカード"]?.sale, 1000);
    const captured = order({
      id: "cap",
      transactions: [
        { id: "cap-1", createdAt: "2026-11-22T01:00:00Z", kind: "AUTHORIZATION", status: "SUCCESS", amountSet: money(1000), gateway: "credit_card" },
        { id: "cap-2", createdAt: "2026-11-22T01:05:00Z", kind: "CAPTURE", amountSet: money(1000), gateway: "credit_card" },
      ],
    });
    assert.equal(aggregateGasStyleForOrders([captured], inDay, undefined, undefined, byOrder).pay["クレジットカード"]?.sale, 1000);
  });

  it("注文の日: 失敗・取り消し（VOID）のオーソリは売上にも件数にも入れない", () => {
    const byOrder = opts({ saleDateBasis: "order" });
    const failed = order({
      id: "auth-failed",
      transactions: [
        { id: "f-1", createdAt: "2026-11-22T01:00:00Z", kind: "AUTHORIZATION", status: "FAILURE", amountSet: money(1000), gateway: "credit_card" },
      ],
    });
    const voided = order({
      id: "auth-voided",
      transactions: [
        { id: "v-1", createdAt: "2026-11-22T01:00:00Z", kind: "AUTHORIZATION", status: "SUCCESS", amountSet: money(2000), gateway: "credit_card" },
        { id: "v-2", createdAt: "2026-11-22T02:00:00Z", kind: "VOID", status: "SUCCESS", parentTransaction: { id: "v-1" }, amountSet: money(2000), gateway: "credit_card" },
      ],
    });
    const voidFailed = order({
      id: "auth-void-failed",
      transactions: [
        { id: "w-1", createdAt: "2026-11-22T01:00:00Z", kind: "AUTHORIZATION", status: "SUCCESS", amountSet: money(3000), gateway: "credit_card" },
        { id: "w-2", createdAt: "2026-11-22T02:00:00Z", kind: "VOID", status: "FAILURE", parentTransaction: { id: "w-1" }, amountSet: money(3000), gateway: "credit_card" },
      ],
    });
    const gas = aggregateGasStyleForOrders([failed, voided], inDay, undefined, undefined, byOrder);
    assert.equal(gas.pay["クレジットカード"]?.sale ?? 0, 0);
    assert.equal(gas.pay["クレジットカード"]?.saleTx ?? 0, 0);
    assert.equal(gas.saleOrderSet.size, 0);
    // 取り消しに失敗した VOID は取り消しになっていないので、オーソリを数える
    const gas2 = aggregateGasStyleForOrders([voidFailed], inDay, undefined, undefined, byOrder);
    assert.equal(gas2.pay["クレジットカード"]?.sale, 3000);
    assert.equal(gas2.pay["クレジットカード"]?.saleTx, 1);
  });
});

describe("点数に数えない商品", () => {
  const sku = (s: string, price: number, quantity: number) => ({ quantity, sku: s, originalUnitPriceSet: money(price) });

  it("印の付いた SKU の 0 円の明細だけ外す", () => {
    const keys = new Set(["NOV-1"]);
    assert.equal(isItemCountExcludedLine(sku("nov-1 ", 0, 1), keys), true);
    assert.equal(isItemCountExcludedLine(sku("NOV-1", 500, 1), keys), false);
    assert.equal(isItemCountExcludedLine(sku("OTHER", 0, 1), keys), false);
    assert.equal(isItemCountExcludedLine(sku("NOV-1", 0, 1), new Set()), false);
  });

  it("売上の点数と返品の点数の両方で外す", () => {
    const o = order({
      id: "nov",
      lineItems: { nodes: [sku("A-1", 1000, 2), sku("NOV-1", 0, 1)] },
      transactions: [
        { id: "nov-sale", createdAt: "2026-11-22T01:00:00Z", kind: "SALE", amountSet: money(2000), gateway: "cash" },
        { id: "nov-ref", createdAt: "2026-11-22T03:00:00Z", kind: "REFUND", amountSet: money(1000), gateway: "cash" },
      ],
      totalPriceSet: money(2000),
      refunds: [
        {
          createdAt: "2026-11-22T03:00:00Z",
          refundLineItems: [
            { quantity: 1, lineItem: { sku: "A-1", originalUnitPriceSet: money(1000) } },
            { quantity: 1, lineItem: { sku: "NOV-1", originalUnitPriceSet: money(0) } },
          ],
          transactions: [{ id: "nov-ref", kind: "REFUND", amountSet: money(1000), gateway: "cash" }],
        },
      ],
    });
    assert.equal(aggregateGasStyleForOrders([o], inDay).itemCount, 1); // 3 − 2
    const gas = aggregateGasStyleForOrders([o], inDay, undefined, undefined, opts({ itemCountExcludedSkuKeys: new Set(["NOV-1"]) }));
    assert.equal(gas.itemCount, 1); // 2 − 1
    const noRefundOrder = order({ id: "nov2", lineItems: { nodes: [sku("A-1", 1000, 2), sku("NOV-1", 0, 3)] } });
    assert.equal(
      aggregateGasStyleForOrders([noRefundOrder], inDay, undefined, undefined, opts({ itemCountExcludedSkuKeys: new Set(["NOV-1"]) })).itemCount,
      2,
    );
  });
});

describe("返金の支払方法の付け替え", () => {
  const rules = [{ match: "wespo", toLabel: "現金", locationId: "100" }];

  it("決めた店の返金だけ付け替え、売上は元の支払方法のまま", () => {
    assert.equal(remapRefundLabel("wespo", { gateway: "wespo" }, rules, "100"), "現金");
    assert.equal(remapRefundLabel("wespo", { gateway: "wespo" }, rules, "200"), "wespo");
    assert.equal(remapRefundLabel("クレジットカード", { gateway: "credit_card" }, rules, "100"), "クレジットカード");
    assert.equal(remapRefundLabel("x", { formattedGateway: "WESPO決済" }, [{ match: "wespo", toLabel: "現金", locationId: "" }], "1"), "現金");

    const o = order({
      id: "w",
      totalPriceSet: money(3000),
      transactions: [
        { id: "w-sale", createdAt: "2026-11-22T01:00:00Z", kind: "SALE", amountSet: money(3000), gateway: "wespo" },
        { id: "w-ref", createdAt: "2026-11-22T03:00:00Z", kind: "REFUND", amountSet: money(1000), gateway: "wespo" },
      ],
    });
    const before = aggregateGasStyleForOrders([o], inDay);
    assert.equal(before.pay["wespo"]?.refund, 1000);
    const gas = aggregateGasStyleForOrders([o], inDay, undefined, undefined, opts({ refundRemapRules: rules, locIdRaw: "100" }));
    assert.equal(gas.pay["wespo"]?.sale, 3000);
    assert.equal(gas.pay["wespo"]?.refund, 0);
    assert.equal(gas.pay["現金"]?.refund, 1000);
    assert.equal(gas.pay["現金"]?.refundTx, 1);
    assert.equal(gas.refundsGross, 1000);
  });
});

describe("支払方法ごとの取引件数", () => {
  it("初めは売上の件数、選ぶと返金の件数を引く（0 より下にしない）", () => {
    assert.equal(paymentSectionTxCount(3, 1, "sales"), 3);
    assert.equal(paymentSectionTxCount(3, 1, "sales_minus_refunds"), 2);
    assert.equal(paymentSectionTxCount(0, 2, "sales_minus_refunds"), 0);
  });
});

describe("ギフトカードの返金", () => {
  const keys = new Set([locationNameKey("Ciara 梅田エスト店")]);
  const dayRange = { startUtc: new Date(DAY_START), endUtc: new Date(DAY_END) };

  it("印と LOC: の店の名前が両方あるメモだけ数える（全角・空白の違いは同じとみなす）", () => {
    assert.equal(matchGiftCardRefundNote("REFUND_CASH | LOC:Ciara梅田エスト店", keys), true);
    assert.equal(matchGiftCardRefundNote("refund_gc｜LOC：Ciara 梅田エスト店", keys), true);
    assert.equal(matchGiftCardRefundNote("LOC:Ciara梅田エスト店", keys), false);
    assert.equal(matchGiftCardRefundNote("REFUND_CASH | LOC:Ciara天王寺ミオ店", keys), false);
  });

  it("メモの日付があればその日、無ければ作った日で決める", () => {
    assert.deepEqual(giftCardRefundNoteDate("DATE:2026-11-22"), { ymd: "2026-11-22" });
    assert.deepEqual(giftCardRefundNoteDate("2026/11/2"), { ymd: "2026-11-02" });
    assert.deepEqual(giftCardRefundNoteDate("2026-11-22T10:00:00"), { ymd: "2026-11-22" });
    assert.equal(giftCardRefundNoteDate("なし"), null);

    const r = sumGiftCardRefunds(
      [
        { note: "REFUND_CASH | LOC:Ciara梅田エスト店 | DATE:2026-11-22", createdAt: "2026-11-23T03:00:00Z", initialValue: { amount: "1000.0" } },
        { note: "REFUND_GC | LOC:Ciara梅田エスト店 | 2026-11-21T23:30:00+09:00", createdAt: "2026-11-21T14:30:00Z", initialValue: { amount: "500" } },
        { note: "REFUND_CASH | LOC:Ciara梅田エスト店", createdAt: "2026-11-22T01:00:00Z", initialValue: { amount: "300" } },
        { note: "REFUND_CASH | LOC:Ciara梅田エスト店", createdAt: "2026-11-22T01:00:00Z", initialValue: { amount: "0" } },
        { note: "REFUND_CASH | LOC:Ciara天王寺ミオ店", createdAt: "2026-11-22T01:00:00Z", initialValue: { amount: "999" } },
      ],
      { targetDate: "2026-11-22", dayRange, locationNameKeys: keys },
    );
    assert.deepEqual(r, { amount: 1300, count: 2 });
  });
});
