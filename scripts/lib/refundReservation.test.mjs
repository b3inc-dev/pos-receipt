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
