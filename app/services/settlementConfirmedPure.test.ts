/**
 * 確定済みの精算を DB の値のまま返すための純粋関数のテスト（Issue #20「確定値を守る」）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
