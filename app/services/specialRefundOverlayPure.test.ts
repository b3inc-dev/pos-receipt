/**
 * P0 M6 — 特殊返金 overlay: execute success 時の二重計上防止と手段変更振替
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  applySpecialRefundEventsToTotals,
  assertNoPendingSpecialRefunds,
  isShopifyRefundPending,
  isShopifyRefundSucceeded,
  SPECIAL_REFUND_PENDING_CODE,
  SpecialRefundPendingError,
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

  it("success は Shopify 元手段から実際の現金へ振り替え、返金総額を増やさない", () => {
    // Shopify は credit_card の親取引へ返金済み、店頭では現金で払い出した想定
    const secs = sections([
      {
        gateway: "クレジットカード",
        label: "クレジットカード",
        net: 1000,
        refund: 300,
        refundCount: 1,
      },
      { gateway: "現金", label: "現金", net: 0, refund: 0, refundCount: 0 },
    ]);
    const totals = { total: 1000, refundTotal: 300 };
    applySpecialRefundEventsToTotals(
      secs,
      [
        {
          eventType: "cash_refund",
          amount: 300,
          originalPaymentMethod: "credit_card",
          actualRefundMethod: "cash",
          adjustKind: null,
          shopifyRefundStatus: "success",
        },
      ],
      totals,
    );
    assert.equal(totals.refundTotal, 300);
    assert.equal(secs[0].refund, 0);
    assert.equal(secs[0].refundCount, 0);
    assert.equal(secs[1].refund, 300);
    assert.equal(secs[1].refundCount, 1);
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
          // API が保存する rawGatewayPattern と集計済み日本語バケットの組合せ
          originalPaymentMethod: "credit_card",
          actualRefundMethod: "cash",
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

  it("元手段を特定できない success は実手段へ追加せず二重控除を防ぐ", () => {
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
          originalPaymentMethod: "unknown_gateway",
          actualRefundMethod: "cash",
          adjustKind: null,
          shopifyRefundStatus: "success",
        },
      ],
      totals,
    );
    assert.equal(totals.refundTotal, 1000);
    assert.equal(secs[0].refund, 1000);
    assert.equal(secs[1].refund, 0);
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

describe("pending（Shopify 返金の成否が分からない）— 監査 P1-1", () => {
  // 監査の場面: クレジットで払った 1,000 円の注文を、特殊返金で現金で返した。
  // Shopify 返金の応答がタイムアウトしたが、Shopify 側では返金ができている（クレジット 1,000 円の REFUND がある）。
  function shopifyAlreadyRefunded() {
    return sections([
      { gateway: "現金", label: "現金", net: 0, refund: 0 },
      { gateway: "クレジット", label: "クレジット", net: 1000, refund: 1000, refundCount: 1 },
    ]);
  }
  const pendingCash = {
    eventType: "cash_refund",
    amount: 1000,
    originalPaymentMethod: "クレジット",
    actualRefundMethod: "現金",
    adjustKind: null,
    shopifyRefundStatus: "pending",
    sourceOrderName: "#1001",
    sourceOrderId: "gid://shopify/Order/1001",
  };

  it("isShopifyRefundPending は pending だけ true", () => {
    assert.equal(isShopifyRefundPending("pending"), true);
    assert.equal(isShopifyRefundPending(" PENDING "), true);
    assert.equal(isShopifyRefundPending("success"), false);
    assert.equal(isShopifyRefundPending("failed"), false);
    assert.equal(isShopifyRefundPending(null), false);
  });

  it("pending は上乗せしない。返金合計は Shopify の 1,000 円のまま（以前は 2,000 円）", () => {
    const secs = shopifyAlreadyRefunded();
    const totals = { total: 0, refundTotal: 1000 };
    applySpecialRefundEventsToTotals(secs, [pendingCash], totals);
    assert.equal(totals.refundTotal, 1000);
    const refundSum = secs.reduce((sum, sec) => sum + sec.refund, 0);
    assert.equal(refundSum, 1000);
    assert.equal(secs.find((x) => x.gateway === "現金")?.refund, 0);
  });

  it("pending の payment_method_override・receipt_cash_adjustment も数えない", () => {
    const secs = shopifyAlreadyRefunded();
    const totals = { total: 0, refundTotal: 1000 };
    applySpecialRefundEventsToTotals(
      secs,
      [
        { ...pendingCash, eventType: "payment_method_override" },
        { ...pendingCash, eventType: "receipt_cash_adjustment", adjustKind: "extra" },
      ],
      totals,
    );
    assert.deepEqual(totals, { total: 0, refundTotal: 1000 });
    assert.equal(secs.reduce((sum, sec) => sum + sec.refund + sec.net, 0), 2000);
  });

  it("精算に入る特殊返金に pending があれば確定しない（注文名を出す）", () => {
    assert.throws(
      () => assertNoPendingSpecialRefunds([pendingCash, { ...pendingCash, sourceOrderName: null, sourceOrderId: "gid://shopify/Order/2002" }]),
      (err: unknown) => {
        assert.ok(err instanceof SpecialRefundPendingError);
        assert.equal((err as SpecialRefundPendingError).code, SPECIAL_REFUND_PENDING_CODE);
        assert.deepEqual((err as SpecialRefundPendingError).orderLabels, ["#1001", "2002"]);
        assert.match((err as Error).message, /#1001/);
        return true;
      },
    );
  });

  it("pending が無ければ止めない（success・failed・skipped・none）", () => {
    for (const status of ["success", "failed", "skipped", "none", null]) {
      assertNoPendingSpecialRefunds([{ ...pendingCash, shopifyRefundStatus: status }]);
    }
    assertNoPendingSpecialRefunds([]);
  });

  it("settlementEngine は上乗せの前に pending を確かめ、精算 API は 409 で返す", () => {
    const engine = readFileSync(new URL("./settlementEngine.server.ts", import.meta.url), "utf8");
    const guard = engine.indexOf("assertNoPendingSpecialRefunds(otherEvents)");
    const apply = engine.indexOf("applySpecialRefundEventsToTotals(");
    assert.ok(guard > 0 && apply > guard);
    const apiErr = readFileSync(new URL("../utils/settlementApiError.server.ts", import.meta.url), "utf8");
    assert.ok(apiErr.includes("SpecialRefundPendingError"));
    const create = readFileSync(new URL("../routes/api.settlements.create.tsx", import.meta.url), "utf8");
    assert.ok(create.includes("instanceof SpecialRefundPendingError"));
  });
});
