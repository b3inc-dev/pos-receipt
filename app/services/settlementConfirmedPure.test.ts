/**
 * 確定済みの精算を DB の値のまま返すための純粋関数のテスト（Issue #20「確定値を守る」）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  diffConfirmedVsLive,
  isConfirmedSettlementRow,
  isInspectionSettlementRow,
  locationIdVariants,
  parseSavedPaymentSections,
  settlementRowToPreview,
} from "./settlementConfirmedPure.server";

const baseRow = {
  locationId: "gid://shopify/Location/1001",
  targetDate: "2026-11-20",
  currency: "JPY",
  total: "31950.00",
  netSales: { toString: () => "29045.45" },
  tax: 2904.55,
  discounts: "0",
  vipPointsUsed: "120",
  refundTotal: "2400",
  orderCount: 30,
  refundCount: 8,
  itemCount: 41,
  voucherChangeAmount: "0",
  paymentSectionsJson: JSON.stringify([
    { gateway: "cash", label: "現金", net: 10000, refund: 300, txCount: 10, refundCount: 1 },
    { label: "クレジット", net: 5000 },
  ]),
};

describe("isConfirmedSettlementRow", () => {
  it("completed / printed の精算は確定済み", () => {
    assert.equal(isConfirmedSettlementRow({ periodLabel: "2026-11-20", status: "completed" }), true);
    assert.equal(isConfirmedSettlementRow({ periodLabel: "2026-11-20", status: "printed" }), true);
  });
  it("draft / failed は確定済みではない", () => {
    assert.equal(isConfirmedSettlementRow({ periodLabel: "2026-11-20", status: "draft" }), false);
    assert.equal(isConfirmedSettlementRow({ periodLabel: "2026-11-20", status: "failed" }), false);
  });
  it("点検レシートは確定済みの精算として扱わない", () => {
    assert.equal(isInspectionSettlementRow({ periodLabel: "点検_2026-11-20" }), true);
    assert.equal(isConfirmedSettlementRow({ periodLabel: "点検_2026-11-20", status: "completed" }), false);
  });
});

describe("locationIdVariants", () => {
  it("GID と数字のどちらからでも両方の形を返す", () => {
    assert.deepEqual(
      locationIdVariants("gid://shopify/Location/1001").sort(),
      ["1001", "gid://shopify/Location/1001"].sort(),
    );
    assert.deepEqual(
      locationIdVariants("1001").sort(),
      ["1001", "gid://shopify/Location/1001"].sort(),
    );
  });
  it("数字でない ID はそのまま", () => {
    assert.deepEqual(locationIdVariants("abc"), ["abc"]);
  });
});

describe("parseSavedPaymentSections", () => {
  it("#22 の発行時スナップショットの形（{format, snapshot, sections}）も読む", () => {
    const json = JSON.stringify({
      format: "v1",
      snapshot: { formVersion: "1", locationName: "本店", title: "精算", isInspection: false },
      sections: [{ gateway: "cash", label: "現金", net: 1200, refund: 0, txCount: 2, refundCount: 0 }],
    });
    const sections = parseSavedPaymentSections(json);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].label, "現金");
    assert.equal(sections[0].net, 1200);
  });
  it("空・壊れた JSON・配列でないものは空にする", () => {
    assert.deepEqual(parseSavedPaymentSections(null), []);
    assert.deepEqual(parseSavedPaymentSections("{bad"), []);
    assert.deepEqual(parseSavedPaymentSections(JSON.stringify({ a: 1 })), []);
  });
});

describe("settlementRowToPreview", () => {
  it("DB に保存した値をそのまま数値で返す（集計し直さない）", () => {
    const p = settlementRowToPreview(baseRow, "本店");
    assert.equal(p.locationName, "本店");
    assert.equal(p.targetDate, "2026-11-20");
    assert.equal(p.total, 31950);
    assert.equal(p.netSales, 29045.45);
    assert.equal(p.tax, 2904.55);
    assert.equal(p.vipPointsUsed, 120);
    assert.equal(p.refundTotal, 2400);
    assert.equal(p.orderCount, 30);
    assert.equal(p.refundCount, 8);
    assert.equal(p.itemCount, 41);
    assert.equal(p.paymentSections.length, 2);
    assert.deepEqual(p.paymentSections[1], {
      gateway: "クレジット",
      label: "クレジット",
      net: 5000,
      refund: 0,
      txCount: 0,
      refundCount: 0,
    });
    assert.deepEqual(p.appliedSpecialRefundEvents, []);
    assert.equal(p.settlementTxFirstHm, null);
  });
  it("通貨が無い行は JPY（印字ルートと同じ既定値）", () => {
    const p = settlementRowToPreview({ ...baseRow, currency: null }, "");
    assert.equal(p.currency, "JPY");
  });
});

describe("diffConfirmedVsLive（確定のあとに数が変わったか）", () => {
  const confirmed = settlementRowToPreview(baseRow, "本店");
  it("同じなら違いなし", () => {
    assert.deepEqual(diffConfirmedVsLive(confirmed, { ...confirmed }).changedFields, []);
  });
  it("小数の差は円にそろえて比べる", () => {
    assert.deepEqual(
      diffConfirmedVsLive(confirmed, { ...confirmed, netSales: 29045.4 }).changedFields,
      [],
    );
  });
  it("合計・件数が変われば項目を返す", () => {
    const live = { ...confirmed, total: 33020, orderCount: 31 };
    assert.deepEqual(diffConfirmedVsLive(confirmed, live).changedFields, ["total", "orderCount"]);
  });
  it("支払方法別の内訳だけが変わっても違いにする", () => {
    const live = {
      ...confirmed,
      paymentSections: confirmed.paymentSections.map((s, i) => (i === 0 ? { ...s, refund: 600 } : s)),
    };
    assert.deepEqual(diffConfirmedVsLive(confirmed, live).changedFields, ["paymentSections"]);
  });
  it("0 だけの行が片方にしか無いのは違いにしない", () => {
    const live = {
      ...confirmed,
      paymentSections: [
        ...confirmed.paymentSections,
        { gateway: "paypay", label: "PayPay", net: 0, refund: 0, txCount: 0, refundCount: 0 },
      ],
    };
    assert.deepEqual(diffConfirmedVsLive(confirmed, live).changedFields, []);
  });
});
