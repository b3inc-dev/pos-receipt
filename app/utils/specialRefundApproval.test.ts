import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalAllowsSettlement,
  awaitingApprovalWarningMessage,
  checkApprovalDecision,
  initialApprovalStatus,
  normalizeApprovalStatus,
  partitionSpecialRefundEventsByApproval,
  resolveApprovalDecidedBy,
  approvalDecidedByLabel,
} from "./specialRefundApproval";
import { DEFAULT_SPECIAL_REFUND_SETTINGS } from "./appSettings.server";

test("初めの値はオフ（今までどおり承認なしで精算に入る）", () => {
  assert.equal(DEFAULT_SPECIAL_REFUND_SETTINGS.requireApprovalForPaymentMethodOverride, false);
  assert.equal(initialApprovalStatus(DEFAULT_SPECIAL_REFUND_SETTINGS, "payment_method_override"), "none");
  // 保存した設定にキーが無い店（前からの店）もオフ
  assert.equal(initialApprovalStatus({}, "payment_method_override"), "none");
});

test("オンのときは返金手段変更だけ承認待ち", () => {
  const on = { requireApprovalForPaymentMethodOverride: true };
  assert.equal(initialApprovalStatus(on, "payment_method_override"), "pending");
  for (const t of ["cash_refund", "receipt_cash_adjustment", "voucher_change_adjustment"]) {
    assert.equal(initialApprovalStatus(on, t), "none", t);
  }
});

test("承認待ち・却下は精算に数えない。知らない値は none 扱い", () => {
  assert.equal(approvalAllowsSettlement("none"), true);
  assert.equal(approvalAllowsSettlement("approved"), true);
  assert.equal(approvalAllowsSettlement(undefined), true);
  assert.equal(approvalAllowsSettlement("pending"), false);
  assert.equal(approvalAllowsSettlement("rejected"), false);
  assert.equal(normalizeApprovalStatus("weird"), "none");
});

test("分け方: 数える・承認待ち・却下", () => {
  const r = partitionSpecialRefundEventsByApproval([
    { id: "a", approvalStatus: "none" },
    { id: "b", approvalStatus: "pending" },
    { id: "c", approvalStatus: "approved" },
    { id: "d", approvalStatus: "rejected" },
    { id: "e" },
  ]);
  assert.deepEqual(r.counted.map((e) => e.id), ["a", "c", "e"]);
  assert.deepEqual(r.awaitingApproval.map((e) => e.id), ["b"]);
  assert.deepEqual(r.rejected.map((e) => e.id), ["d"]);
});

test("承認／却下を受けるのは有効な承認待ちだけ", () => {
  assert.deepEqual(checkApprovalDecision({ status: "active", approvalStatus: "pending" }, "approve"), {
    ok: true,
    next: "approved",
  });
  assert.deepEqual(checkApprovalDecision({ status: "active", approvalStatus: "pending" }, "reject"), {
    ok: true,
    next: "rejected",
  });
  const bad = checkApprovalDecision({ status: "active", approvalStatus: "pending" }, "maybe");
  assert.equal(bad.ok, false);
  const done = checkApprovalDecision({ status: "active", approvalStatus: "approved" }, "reject");
  assert.equal(done.ok, false);
  assert.equal(!done.ok && done.code, "NOT_PENDING");
  const voided = checkApprovalDecision({ status: "voided", approvalStatus: "pending" }, "approve");
  assert.equal(!voided.ok && voided.code, "VOIDED");
});

test("警告の文に件数と注文番号が出る", () => {
  const msg = awaitingApprovalWarningMessage([
    { id: "1", eventType: "payment_method_override", amount: 500, sourceOrderName: "#1001" },
    { id: "2", eventType: "payment_method_override", amount: 300, sourceOrderName: null },
  ]);
  assert.match(msg, /2 件/);
  assert.match(msg, /#1001/);
});

test("決めた人: オンラインのセッションの名前 → メール → セッショントークンのユーザー ID → null", () => {
  assert.equal(
    resolveApprovalDecidedBy({
      session: { onlineAccessInfo: { associated_user: { first_name: "花子", last_name: "山田", email: "h@example.com" } } },
      sessionToken: { sub: "42" },
    }),
    "山田 花子",
  );
  assert.equal(
    resolveApprovalDecidedBy({ session: { onlineAccessInfo: { associated_user: { email: "h@example.com" } } } }),
    "h@example.com",
  );
  assert.equal(resolveApprovalDecidedBy({ session: {}, sessionToken: { sub: "42" } }), "shopify_user:42");
  assert.equal(resolveApprovalDecidedBy({ session: {}, sessionToken: { sub: "gid://x" } }), null);
  assert.equal(resolveApprovalDecidedBy({}), null);
  assert.equal(approvalDecidedByLabel("shopify_user:42"), "ユーザー ID 42");
  assert.equal(approvalDecidedByLabel("山田 花子"), "山田 花子");
  assert.equal(approvalDecidedByLabel(null), null);
});
