/**
 * 特殊返金の返金方法が支払方法マスタに無いとき「未分類」の行に載せ、警告を返す
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySpecialRefundEventsToTotals,
  UNMATCHED_REFUND_SECTION_KEY,
  unmatchedRefundWarningMessage,
  type OverlayPaymentSection,
  type SpecialRefundOverlayOpts,
} from "./specialRefundOverlayPure.server";
import { isKnownRefundMethod, type PaymentMethodMatchInput } from "../utils/paymentMethodMatch.server";
import { gasNormalizeGatewayLabel } from "./settlementAggregatePure.server";

function sec(gateway: string, label: string, net = 0, refund = 0, refundCount = 0): OverlayPaymentSection {
  return { gateway, label, net, refund, txCount: 0, refundCount };
}

const masters: PaymentMethodMatchInput[] = [
  { rawGatewayPattern: "cash", matchType: "exact_match", displayLabel: "現金", enabled: true },
  { rawGatewayPattern: "lumine_point", matchType: "exact_match", displayLabel: "ルミネポイント", enabled: true },
];

const opts: SpecialRefundOverlayOpts = {
  isKnownMethod: (m) => isKnownRefundMethod(m, masters, (x) => gasNormalizeGatewayLabel(x)),
  labelForMethod: (m) => masters.find((x) => x.rawGatewayPattern === m)?.displayLabel ?? m,
};

const sum = (ss: OverlayPaymentSection[]) => ss.reduce((s, x) => s + x.net - x.refund, 0);

describe("isKnownRefundMethod", () => {
  it("マスタ・既定の名前（cash など）・集計キーで分かる", () => {
    assert.equal(isKnownRefundMethod("lumine_point", masters), true);
    assert.equal(isKnownRefundMethod("ルミネポイント", masters), true); // 表示名の完全一致
    assert.equal(isKnownRefundMethod("shopify_payments", []), true); // 既定の名前
    assert.equal(isKnownRefundMethod("CASH", []), true);
    assert.equal(isKnownRefundMethod("現金", masters, gasNormalizeGatewayLabel), true);
  });
  it("マスタに無い手段・空は分からない", () => {
    assert.equal(isKnownRefundMethod("facility_point", masters, gasNormalizeGatewayLabel), false);
    assert.equal(isKnownRefundMethod("", masters), false);
  });
});

describe("applySpecialRefundEventsToTotals: マスタに無い返金方法", () => {
  it("cash_refund（Shopify 返金なし）: 未分類の行に載せ、警告を返す。合計は今までと同じ", () => {
    const ss = [sec("現金", "現金", 10000)];
    const totals = { total: 10000, refundTotal: 0 };
    const w = applySpecialRefundEventsToTotals(
      ss,
      [{ eventType: "cash_refund", amount: 1200, originalPaymentMethod: "cash", actualRefundMethod: "facility_point", adjustKind: null, sourceOrderName: "#1001" }],
      totals,
      opts,
    );
    assert.equal(totals.refundTotal, 1200);
    const unknown = ss.find((x) => x.gateway === UNMATCHED_REFUND_SECTION_KEY);
    assert.ok(unknown);
    assert.equal(unknown.label, "未分類");
    assert.equal(unknown.refund, 1200);
    assert.equal(ss[0].refund, 0, "1 行目（現金）には載せない");
    assert.equal(sum(ss), 8800);
    assert.deepEqual(w, [
      { reason: "refund_method_not_in_master", eventType: "cash_refund", amount: 1200, method: "facility_point", sourceOrderName: "#1001" },
    ]);
    assert.match(unmatchedRefundWarningMessage(w[0]), /facility_point.*未分類/);
  });

  it("opts を渡さなければ今までどおり（その名前で行を作る・警告なし）", () => {
    const ss = [sec("現金", "現金", 10000)];
    const totals = { total: 10000, refundTotal: 0 };
    const w = applySpecialRefundEventsToTotals(
      ss,
      [{ eventType: "cash_refund", amount: 1200, originalPaymentMethod: "cash", actualRefundMethod: "facility_point", adjustKind: null }],
      totals,
    );
    assert.deepEqual(w, []);
    assert.equal(ss[1].gateway, "facility_point");
    assert.equal(ss[1].refund, 1200);
  });

  it("マスタにある手段でその日の行が無いときは、マスタの表示名で行を作る", () => {
    const ss = [sec("現金", "現金", 10000)];
    const totals = { total: 10000, refundTotal: 0 };
    const w = applySpecialRefundEventsToTotals(
      ss,
      [{ eventType: "payment_method_override", amount: 500, originalPaymentMethod: "cash", actualRefundMethod: "lumine_point", adjustKind: null }],
      totals,
      opts,
    );
    assert.deepEqual(w, []);
    assert.equal(ss[1].gateway, "lumine_point");
    assert.equal(ss[1].label, "ルミネポイント");
    assert.equal(ss[1].refund, 500);
  });

  it("Shopify 返金済み（success）の付け替え: 返金方法がマスタに無ければ未分類へ移す。合計は変わらない", () => {
    const ss = [sec("現金", "現金", 10000, 3000, 1)];
    const totals = { total: 7000, refundTotal: 3000 };
    const before = sum(ss);
    const w = applySpecialRefundEventsToTotals(
      ss,
      [{ eventType: "cash_refund", amount: 3000, originalPaymentMethod: "cash", actualRefundMethod: "facility_point", adjustKind: null, shopifyRefundStatus: "success" }],
      totals,
      opts,
    );
    assert.equal(sum(ss), before);
    assert.equal(totals.refundTotal, 3000);
    assert.equal(ss[0].refund, 0);
    assert.equal(ss.find((x) => x.gateway === "未分類")?.refund, 3000);
    assert.equal(w.length, 1);
    assert.equal(w[0].reason, "refund_method_not_in_master");
  });

  it("Shopify 返金済みで元の支払方法の行が無い: 何も動かさず警告だけ返す", () => {
    const ss = [sec("現金", "現金", 10000)];
    const totals = { total: 10000, refundTotal: 0 };
    const w = applySpecialRefundEventsToTotals(
      ss,
      [{ eventType: "payment_method_override", amount: 800, originalPaymentMethod: "paypay", actualRefundMethod: "cash", adjustKind: null, shopifyRefundStatus: "success" }],
      totals,
      opts,
    );
    assert.equal(ss.length, 1);
    assert.equal(ss[0].refund, 0);
    assert.equal(w.length, 1);
    assert.equal(w[0].reason, "original_method_not_found");
    assert.equal(w[0].method, "paypay");
  });

  it("その日に「未分類」の行があれば、そこにまとめる", () => {
    const ss = [sec("現金", "現金", 10000), sec("未分類", "未分類", 2000)];
    const totals = { total: 12000, refundTotal: 0 };
    applySpecialRefundEventsToTotals(
      ss,
      [
        { eventType: "cash_refund", amount: 100, originalPaymentMethod: "cash", actualRefundMethod: "facility_point", adjustKind: null },
        { eventType: "cash_refund", amount: 200, originalPaymentMethod: "cash", actualRefundMethod: "other_point", adjustKind: null },
      ],
      totals,
      opts,
    );
    assert.equal(ss.length, 2);
    assert.equal(ss[1].refund, 300);
  });

  it("レシート調整の支払方法の行が無いとき: 金額の扱いは今のまま、警告だけ返す", () => {
    const ss = [sec("現金", "現金", 10000, 500)];
    const totals = { total: 9500, refundTotal: 500 };
    const w = applySpecialRefundEventsToTotals(
      ss,
      [{ eventType: "receipt_cash_adjustment", amount: 300, originalPaymentMethod: "paypay", actualRefundMethod: null, adjustKind: "undo" }],
      totals,
      opts,
    );
    assert.equal(totals.refundTotal, 200);
    assert.equal(ss[0].refund, 500);
    assert.equal(w.length, 1);
    assert.equal(w[0].reason, "adjust_method_not_found");
  });

  it("マスタにある手段・cash は警告しない", () => {
    const ss = [sec("現金", "現金", 10000)];
    const totals = { total: 10000, refundTotal: 0 };
    const w = applySpecialRefundEventsToTotals(
      ss,
      [{ eventType: "cash_refund", amount: 100, originalPaymentMethod: "cash", actualRefundMethod: "cash", adjustKind: null }],
      totals,
      opts,
    );
    assert.deepEqual(w, []);
    assert.equal(ss[0].refund, 100);
  });
});
