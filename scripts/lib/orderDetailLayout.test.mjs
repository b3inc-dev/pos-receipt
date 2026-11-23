import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { adjustmentKindLabel, adjustmentSubLines, financialStatusTone, orderPaymentSummaryLines, reassignmentSummaryLines } from "../../extensions/common/orderDetailLayout.js";

describe("orderPaymentSummaryLines", () => {
  it("支払いと返金を支払方法ごとに出し、返金は赤のマイナス", () => {
    const lines = orderPaymentSummaryLines({
      transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "cash", displayName: "現金", amount: "3325" }],
      refunds: [{ totalRefunded: "1100", transactions: [{ gateway: "cash", displayName: "現金", amount: "1100" }] }],
    });
    assert.deepEqual(
      lines.map((l) => [l.label, l.value, l.tone]),
      [
        ["支払い ・ 現金", "¥3,325", undefined],
        ["返金 ・ 現金", "−¥1,100", "critical"],
      ],
    );
  });

  it("返金の取引が無く返金額だけあるときは合計を 1 行", () => {
    const lines = orderPaymentSummaryLines({
      transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "cash", displayName: "現金", amount: "500" }],
      refunds: [{ totalRefunded: "200", transactions: [] }],
    });
    assert.deepEqual(lines.at(-1), { key: "refund-total", label: "返金", value: "−¥200", tone: "critical" });
  });

  it("失敗した取引は出さない・注文が無くても落ちない", () => {
    assert.deepEqual(
      orderPaymentSummaryLines({ transactions: [{ kind: "SALE", status: "FAILURE", gateway: "cash", amount: "100" }] }),
      [],
    );
    assert.deepEqual(orderPaymentSummaryLines(null), []);
  });
});

describe("financialStatusTone", () => {
  it("一覧のバッジと同じ: キャンセル=赤、一部返金=黄、返金済=橙、ほか=灰", () => {
    assert.equal(financialStatusTone("PAID", "2026-11-23T00:00:00Z"), "critical");
    assert.equal(financialStatusTone("PARTIALLY_REFUNDED"), "caution");
    assert.equal(financialStatusTone("REFUNDED"), "warning");
    assert.equal(financialStatusTone("PAID"), "neutral");
  });
});

describe("customerLabel", async () => {
  const { customerLabel } = await import("../../extensions/common/orderDetailLayout.js");
  it("名前 → 名前、名前なしで読み直したとき → 顧客あり、顧客がいない → 顧客なし", () => {
    assert.equal(customerLabel({ customer: { id: "gid://shopify/Customer/1", displayName: "山田 太郎" } }), "山田 太郎");
    assert.equal(customerLabel({ customer: { id: "gid://shopify/Customer/1" } }), "顧客あり（名前は表示できません）");
    assert.equal(customerLabel({ customer: null }), "顧客なし");
    assert.equal(customerLabel(null), "顧客なし");
  });
});

describe("調整履歴の行", async () => {
  const { adjustmentBadges, adjustmentSubLines } = await import("../../extensions/common/orderDetailLayout.js");
  it("返金の状態と承認の状態を色の印にする", () => {
    assert.deepEqual(
      adjustmentBadges({ shopifyRefundStatus: "success", approvalStatus: "pending" }).map((b) => [b.label, b.tone]),
      [["返金済", "success"], ["承認待ち", "caution"]],
    );
    assert.deepEqual(adjustmentBadges({ shopifyRefundStatus: "none" }), []);
  });
  it("手段・いつの精算・登録日時を灰色の行にする", () => {
    assert.deepEqual(
      adjustmentSubLines({
        eventType: "cash_refund",
        originalPaymentMethod: "cash",
        originalPaymentLabel: "現金",
        actualRefundMethod: "cash",
        actualRefundLabel: "現金",
        countDate: "2026-11-23",
        createdAtLabel: "11/23 18:21",
      }),
      ["現金のまま（返金方法の変更なし）", "11/23 の精算 ・ 登録 11/23 18:21"],
    );
  });
  it("商品券は額面・払った額・お釣りを出す", () => {
    const lines = adjustmentSubLines({
      eventType: "voucher_change_adjustment",
      voucherFaceValue: 1000,
      voucherAppliedAmount: 800,
      voucherChangeAmount: 200,
    });
    assert.equal(lines[0], "額面 ¥1,000 ・ 商品券で払った額 ¥800 ・ お釣り ¥200");
  });
});

test("reassignmentSummaryLines: 付け替えた手段ごとの内訳（同じ手段・無効・却下は出さない）", () => {
  const lines = reassignmentSummaryLines([
    { status: "active", eventType: "cash_refund", amount: "500", originalPaymentMethod: "cash", originalPaymentLabel: "現金", actualRefundMethod: "credit", actualRefundLabel: "クレジットカード" },
    { status: "active", eventType: "payment_method_override", amount: 100, originalPaymentMethod: "Cash", actualRefundMethod: "credit", actualRefundLabel: "クレジットカード", originalPaymentLabel: "現金", approvalStatus: "pending" },
    { status: "active", eventType: "cash_refund", amount: 300, originalPaymentMethod: "cash", actualRefundMethod: "cash" },
    { status: "voided", eventType: "cash_refund", amount: 900, originalPaymentMethod: "cash", actualRefundMethod: "wespo" },
    { status: "active", eventType: "cash_refund", amount: 900, originalPaymentMethod: "cash", actualRefundMethod: "wespo", approvalStatus: "rejected" },
    { status: "active", eventType: "receipt_cash_adjustment", amount: 50 },
  ]);
  assert.deepEqual(lines.map((l) => l.text), ["うち ¥600 はクレジットカードで返金（現金から返金方法変更・承認待ち）"]);
});

test("adjustmentKindLabel: 返金の付け替えは手段を変えても同じ名前", () => {
  assert.equal(adjustmentKindLabel({ eventType: "cash_refund" }), "返金方法変更");
  assert.equal(adjustmentKindLabel({ eventType: "payment_method_override" }), "返金方法変更");
  assert.equal(adjustmentKindLabel({ eventType: "cash_refund", refundSource: "native" }), "返金方法変更");
  assert.equal(adjustmentKindLabel({ eventType: "voucher_change_adjustment" }), "商品券調整");
});

test("adjustmentSubLines: 手段が変わらない行は「のまま（返金方法の変更なし）」", () => {
  const lines = adjustmentSubLines({ eventType: "cash_refund", originalPaymentMethod: "cash", originalPaymentLabel: "現金", actualRefundMethod: "Cash", actualRefundLabel: "現金" });
  assert.equal(lines[0], "現金のまま（返金方法の変更なし）");
  const moved = adjustmentSubLines({ eventType: "payment_method_override", originalPaymentMethod: "cash", originalPaymentLabel: "現金", actualRefundMethod: "credit", actualRefundLabel: "クレジットカード" });
  assert.equal(moved[0], "現金 → クレジットカード で返金");
});
