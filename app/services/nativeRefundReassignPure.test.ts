/**
 * POS 純正の返金の付け替え（純関数）の試験
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkNativeReassign,
  isAppExecutedRefundNote,
  nativeRefundLines,
  NATIVE_REFUND_AMOUNT_EXCEEDED_CODE,
  NATIVE_REFUND_NOT_FOUND_CODE,
  remainingFor,
} from "./nativeRefundReassignPure.server";

const tx = (gateway: string, amount: string, extra: Record<string, string> = {}) => ({
  kind: "REFUND",
  status: "SUCCESS",
  gateway,
  amountSet: { shopMoney: { amount } },
  ...extra,
});

const refunds = [
  { id: "r2", createdAt: "2026-11-23T05:00:00Z", note: null, transactions: { nodes: [tx("points", "2000")] } },
  {
    id: "r1",
    createdAt: "2026-11-22T05:00:00Z",
    note: "",
    transactions: { nodes: [tx("points", "3000"), tx("Points", "1000"), tx("cash", "500"), tx("cash", "9", { status: "FAILURE" })] },
  },
  // このアプリが Shopify で実行した返金は純正ではない
  { id: "r3", createdAt: "2026-11-23T06:00:00Z", note: "[POS_RECEIPT_EVENT:pos_sr_x] / 特殊返金", transactions: { nodes: [tx("points", "700")] } },
];

describe("nativeRefundLines", () => {
  it("返金 1 件・支払方法 1 つずつにまとめ、古い順。失敗の取引・アプリの返金は外す", () => {
    const lines = nativeRefundLines(refunds);
    assert.deepEqual(
      lines.map((l) => [l.refundId, l.gateway.toLowerCase(), l.amount]),
      [
        ["r1", "points", 4000],
        ["r1", "cash", 500],
        ["r2", "points", 2000],
      ],
    );
  });
  it("返金ノートの印でアプリの返金を見分ける", () => {
    assert.equal(isAppExecutedRefundNote("[POS_RECEIPT_EVENT:pos_sr_a]"), true);
    assert.equal(isAppExecutedRefundNote("POS Receipt 特殊返金 / cash_refund"), true);
    assert.equal(isAppExecutedRefundNote("お客様都合"), false);
  });
});

describe("checkNativeReassign", () => {
  const lines = nativeRefundLines(refunds);
  const ev = (amount: number, extra: Record<string, unknown> = {}) => ({
    status: "active",
    approvalStatus: "none",
    shopifyRefundId: "r1",
    originalPaymentMethod: "points",
    amount,
    ...extra,
  });

  it("残りまでなら通る（分けて登録しても合計は返金額まで）", () => {
    assert.equal(checkNativeReassign(lines, [], { refundId: "r1", originalPaymentMethod: "points", amount: 4000 }).ok, true);
    const after = [ev(2500)];
    assert.equal(remainingFor(lines[0], after), 1500);
    assert.equal(checkNativeReassign(lines, after, { refundId: "r1", originalPaymentMethod: "POINTS", amount: 1500 }).ok, true);
  });
  it("残りを超えると止める・付け替え済みは止める", () => {
    const r = checkNativeReassign(lines, [ev(2500)], { refundId: "r1", originalPaymentMethod: "points", amount: 1501 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, NATIVE_REFUND_AMOUNT_EXCEEDED_CODE);
    const full = checkNativeReassign(lines, [ev(4000)], { refundId: "r1", originalPaymentMethod: "points", amount: 1 });
    assert.equal(full.ok, false);
  });
  it("無効にした・却下された付け替えは残りに戻る。ほかの返金・支払方法の登録は数えない", () => {
    const events = [
      ev(4000, { status: "voided" }),
      ev(4000, { approvalStatus: "rejected" }),
      ev(4000, { shopifyRefundId: "r2" }),
      ev(500, { originalPaymentMethod: "cash" }),
    ];
    assert.equal(remainingFor(lines[0], events), 4000);
    // 承認待ちは残りから引く（承認されれば数えるため）
    assert.equal(remainingFor(lines[0], [ev(1000, { approvalStatus: "pending" })]), 3000);
  });
  it("その返金・支払方法が無ければ止める", () => {
    const r = checkNativeReassign(lines, [], { refundId: "r9", originalPaymentMethod: "points", amount: 100 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, NATIVE_REFUND_NOT_FOUND_CODE);
    const r2 = checkNativeReassign(lines, [], { refundId: "r2", originalPaymentMethod: "cash", amount: 100 });
    assert.equal(r2.ok, false);
  });
  it("アプリが実行した返金は付け替えの対象にしない", () => {
    assert.equal(checkNativeReassign(lines, [], { refundId: "r3", originalPaymentMethod: "points", amount: 700 }).ok, false);
  });
});

describe("精算での数え方（分けて付け替えた純正の返金）", () => {
  it("施設ポイントの純正返金 4000 を 現金 2500＋施設ポイント 1500 に分けても、返金の合計は 4000 のまま", async () => {
    const { applySpecialRefundEventsToTotals } = await import("./specialRefundOverlayPure.server");
    const sections = [{ gateway: "points", label: "施設ポイント", net: 10000, refund: 4000, txCount: 1, refundCount: 1 }];
    const totals = { total: 6000, refundTotal: 4000 };
    const base = { originalPaymentMethod: "points", adjustKind: null, shopifyRefundStatus: "success" };
    applySpecialRefundEventsToTotals(
      sections,
      [
        { ...base, eventType: "cash_refund", amount: 2500, actualRefundMethod: "cash" },
        { ...base, eventType: "payment_method_override", amount: 1500, actualRefundMethod: "points" },
      ],
      totals,
    );
    assert.equal(totals.refundTotal, 4000);
    assert.equal(sections.find((s) => s.gateway === "points")!.refund, 1500);
    assert.equal(sections.find((s) => s.gateway === "cash")!.refund, 2500);
  });
});
