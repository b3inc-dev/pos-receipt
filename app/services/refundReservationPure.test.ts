import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReservationRows,
  pickRefundForReservation,
  planReservation,
  reservationEventId,
  reservationExpired,
} from "./refundReservationPure";

const line = (refundId: string, createdAt: string, gateway: string, amount: number) => ({
  refundId,
  createdAt,
  gateway,
  formattedGateway: null,
  amount,
});

test("行を確かめる: 最後の行は残り（金額を捨てる）、手段・種類が要る", () => {
  const ok = normalizeReservationRows([
    { actualRefundMethod: "cash", eventType: "cash_refund", amount: "1000" },
    { actualRefundMethod: "facility_point", eventType: "payment_method_override", amount: 999 },
  ]);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.rows[0].amount, 1000);
    assert.equal(ok.rows[1].amount, null);
  }
  assert.equal(normalizeReservationRows([]).ok, false);
  assert.equal(normalizeReservationRows([{ actualRefundMethod: "", eventType: "cash_refund" }]).ok, false);
  assert.equal(normalizeReservationRows([{ actualRefundMethod: "cash", eventType: "voucher_change_adjustment" }]).ok, false);
  assert.equal(
    normalizeReservationRows([
      { actualRefundMethod: "cash", eventType: "cash_refund", amount: 0 },
      { actualRefundMethod: "cash", eventType: "cash_refund" },
    ]).ok,
    false,
  );
});

test("予約した日が終わったら使わない", () => {
  assert.equal(reservationExpired("2026-11-23", "2026-11-23"), false);
  assert.equal(reservationExpired("2026-11-23", "2026-11-24"), true);
});

test("予約のあとにできた、まだ付け替えていない最初の返金に当てる", () => {
  const lines = [
    line("gid://shopify/Refund/1", "2026-11-23T01:00:00Z", "shopify_payments", 500), // 予約の前
    line("gid://shopify/Refund/2", "2026-11-23T03:00:00Z", "shopify_payments", 800),
    line("gid://shopify/Refund/3", "2026-11-23T04:00:00Z", "shopify_payments", 300),
  ];
  const picked = pickRefundForReservation(lines, [], "2026-11-23T02:00:00Z");
  assert.equal(picked?.refundId, "gid://shopify/Refund/2");
  // 2 がもう手で付け替え済みなら 3
  const events = [{ status: "active", shopifyRefundId: "gid://shopify/Refund/2", originalPaymentMethod: "shopify_payments", amount: 100 }];
  assert.equal(pickRefundForReservation(lines, events, "2026-11-23T02:00:00Z")?.refundId, "gid://shopify/Refund/3");
  assert.equal(pickRefundForReservation(lines, [], "2026-11-23T05:00:00Z"), null, "まだ返金が無い");
});

test("金額は返金額で固定・最後は残り・元と同じ手段の行は作らない", () => {
  const l = line("r", "2026-11-23T03:00:00Z", "facility_point", 3000);
  const one = planReservation([l], [{ actualRefundMethod: "cash", eventType: "cash_refund", amount: null }]);
  assert.equal(one.ok, true);
  if (one.ok) assert.deepEqual(one.rows.map((r) => [r.index, r.amount]), [[0, 3000]]);

  const split = planReservation([l], [
    { actualRefundMethod: "cash", eventType: "cash_refund", amount: 1000 },
    { actualRefundMethod: "facility_point", eventType: "payment_method_override", amount: 500 },
    { actualRefundMethod: "gift", eventType: "payment_method_override", amount: null },
  ]);
  assert.equal(split.ok, true);
  if (split.ok) {
    // 2 行目は元と同じ手段なので作らない。3 行目は残り 1,500
    assert.deepEqual(split.rows.map((r) => [r.index, r.actualRefundMethod, r.amount]), [
      [0, "cash", 1000],
      [2, "gift", 1500],
    ]);
  }
});

test("予約の額が返金額より大きい・支払方法が複数のときは要確認", () => {
  const l = line("r", "2026-11-23T03:00:00Z", "facility_point", 800);
  const over = planReservation([l], [
    { actualRefundMethod: "cash", eventType: "cash_refund", amount: 1000 },
    { actualRefundMethod: "cash", eventType: "cash_refund", amount: null },
  ]);
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.reason, /返金額.*より大きい/);
  const multi = planReservation([l, { ...l, gateway: "cash" }], [{ actualRefundMethod: "cash", eventType: "cash_refund", amount: null }]);
  assert.equal(multi.ok, false);
});

test("付け替えの行の id は予約と行の番号で決まる", () => {
  assert.equal(reservationEventId("abc", 2), "pos_rr_abc_2");
});
