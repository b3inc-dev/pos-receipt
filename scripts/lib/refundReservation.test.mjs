import { test } from "node:test";
import assert from "node:assert/strict";

test("返金の予約: 行の読み方と文言", async () => {
  const m = await import("../../extensions/common/refundReservation.js");
  const ok = m.reservationRowsFromInput([{ amount: "1000", method: "cash" }, { amount: "", method: "gift" }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.rows, [{ actualRefundMethod: "cash", amount: 1000 }, { actualRefundMethod: "gift", amount: null }]);
  assert.equal(m.reservationRowsFromInput([{ amount: "", method: "" }]).ok, false);
  assert.equal(m.reservationRowsFromInput([{ amount: "0", method: "cash" }, { method: "gift" }]).ok, false);
  assert.equal(m.reservationRowText({ actualRefundLabel: "現金", amount: 1000 }), "現金 ¥1,000");
  assert.equal(m.reservationRowText({ actualRefundLabel: "施設ポイント", amount: null }), "施設ポイント 残り");
  for (const s of ["pending", "applied", "needs_review", "cancelled", "expired"]) assert.ok(m.reservationStatusLabel(s));
});

test("返金の予約: 返金する金額は要る・分けた額の合計より大きく", async () => {
  const m = await import("../../extensions/common/refundReservation.js");
  const rows = [{ actualRefundMethod: "cash", amount: 1000 }, { actualRefundMethod: "gift", amount: null }];
  assert.equal(m.reservationExpectedAmountFromInput("2500", rows).ok, true);
  assert.equal(m.reservationExpectedAmountFromInput("2500", rows).amount, 2500);
  assert.equal(m.reservationExpectedAmountFromInput("", rows).ok, false);
  assert.equal(m.reservationExpectedAmountFromInput("1000", rows).ok, false);
});

test("返品・交換が終わった画面の一行: 予約が無い・古いときは出さない", async () => {
  const m = await import("../../extensions/common/refundReservation.js");
  const now = Date.parse("2026-11-24T03:00:00Z");
  assert.equal(m.postReturnMessage([], now), null);
  assert.equal(m.postReturnMessage([{ status: "applied", appliedAt: "2026-11-22T03:00:00Z", rows: [] }], now), null);
  const ok = m.postReturnMessage(
    [{ status: "applied", appliedAt: "2026-11-24T02:59:00Z", rows: [{ actualRefundLabel: "現金", amount: null }] }],
    now,
  );
  assert.equal(ok.tone, "success");
  assert.match(ok.text, /現金 残り/);
  assert.equal(m.postReturnMessage([{ status: "pending", createdAt: "2026-11-24T02:00:00Z" }], now).tone, "neutral");
  assert.equal(m.postReturnMessage([{ status: "needs_review", createdAt: "2026-11-24T02:00:00Z", reviewReason: "違う" }], now).text, "違う");
});
