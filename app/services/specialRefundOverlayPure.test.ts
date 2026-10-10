/**
 * P0 M6 — 特殊返金 overlay: execute success 時の二重計上防止と手段変更振替
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySpecialRefundEventsToTotals,
  isShopifyRefundSucceeded,
  type OverlayPaymentSection,
} from "./specialRefundOverlayPure.server";

function sections(
  rows: Array<Partial<OverlayPaymentSection> & { gateway: string; label: string }>,
): OverlayPaymentSection[] {
  return rows.map((r) => ({
    gateway: r.gateway,
    label: r.label,
    net: r.net ?? 0,
    refund: r.refund ?? 0,
    txCount: r.txCount ?? 0,
    refundCount: r.refundCount ?? 0,
  }));
}

describe("isShopifyRefundSucceeded", () => {
  it("success のみ true", () => {
    assert.equal(isShopifyRefundSucceeded("success"), true);
    assert.equal(isShopifyRefundSucceeded("SUCCESS"), true);
    assert.equal(isShopifyRefundSucceeded("pending"), false);
    assert.equal(isShopifyRefundSucceeded("failed"), false);
    assert.equal(isShopifyRefundSucceeded("skipped"), false);
    assert.equal(isShopifyRefundSucceeded("none"), false);
    assert.equal(isShopifyRefundSucceeded(null), false);
  });
});

describe("applySpecialRefundEventsToTotals — cash_refund", () => {
  it("record_only / none は overlay で返金加算する", () => {
    const secs = sections([{ gateway: "現金", label: "現金", net: 1000, refund: 0 }]);
    const totals = { total: 1000, refundTotal: 0 };
    applySpecialRefundEventsToTotals(
      secs,
      [
        {
          eventType: "cash_refund",
          amount: 300,
          originalPaymentMethod: "現金",
          actualRefundMethod: "現金",
          adjustKind: null,
          shopifyRefundStatus: "none",
        },
      ],
      totals,
    );
    assert.equal(totals.refundTotal, 300);
    assert.equal(secs[0].refund, 300);
  });

  it("shopifyRefundStatus===success では overlay 金額加算をスキップ（二重計上防止）", () => {
    // Shopify TX 側で既に 300 返金済み想定
    const secs = sections([{ gateway: "現金", label: "現金", net: 1000, refund: 300 }]);
    const totals = { total: 1000, refundTotal: 300 };
    applySpecialRefundEventsToTotals(
      secs,
      [
        {
          eventType: "cash_refund",
          amount: 300,
          originalPaymentMethod: "現金",
          actualRefundMethod: "現金",
          adjustKind: null,
          shopifyRefundStatus: "success",
        },
      ],
      totals,
    );
    assert.equal(totals.refundTotal, 300);
    assert.equal(secs[0].refund, 300);
  });
});

describe("applySpecialRefundEventsToTotals — payment_method_override", () => {
  it("success 時は親 gateway → 実手段へ振替（refundTotal 不変）", () => {
    // Shopify はクレジットカードへ REFUND 済み
    const secs = sections([
      { gateway: "クレジットカード", label: "クレジットカード", net: 5000, refund: 1000 },
      { gateway: "現金", label: "現金", net: 2000, refund: 0 },
    ]);
    const totals = { total: 6000, refundTotal: 1000 };
    applySpecialRefundEventsToTotals(
      secs,
      [
        {
          eventType: "payment_method_override",
          amount: 1000,
          originalPaymentMethod: "クレジットカード",
          actualRefundMethod: "現金",
          adjustKind: null,
          shopifyRefundStatus: "success",
        },
      ],
      totals,
    );
    assert.equal(totals.refundTotal, 1000);
    assert.equal(secs[0].refund, 0);
    assert.equal(secs[1].refund, 1000);
  });

  it("record_only は実手段へ純 overlay（refundTotal 加算）", () => {
    const secs = sections([
      { gateway: "クレジットカード", label: "クレジットカード", net: 5000, refund: 0 },
      { gateway: "現金", label: "現金", net: 2000, refund: 0 },
    ]);
    const totals = { total: 7000, refundTotal: 0 };
    applySpecialRefundEventsToTotals(
      secs,
      [
        {
          eventType: "payment_method_override",
          amount: 1000,
          originalPaymentMethod: "クレジットカード",
          actualRefundMethod: "現金",
          adjustKind: null,
          shopifyRefundStatus: "skipped",
        },
      ],
      totals,
    );
    assert.equal(totals.refundTotal, 1000);
    assert.equal(secs[0].refund, 0);
    assert.equal(secs[1].refund, 1000);
  });
});

describe("applySpecialRefundEventsToTotals — receipt_cash_adjustment", () => {
  it("success 時は overlay をスキップ", () => {
    const secs = sections([{ gateway: "現金", label: "現金", net: 1000, refund: 200 }]);
    const totals = { total: 1000, refundTotal: 200 };
    applySpecialRefundEventsToTotals(
      secs,
      [
        {
          eventType: "receipt_cash_adjustment",
          amount: 200,
          originalPaymentMethod: "現金",
          actualRefundMethod: "現金",
          adjustKind: "undo",
          shopifyRefundStatus: "success",
        },
      ],
      totals,
    );
    assert.equal(totals.refundTotal, 200);
    assert.equal(secs[0].refund, 200);
  });
});
