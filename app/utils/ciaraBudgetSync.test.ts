import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffSyncedStore, parseCiaraBudgetResponse, syncDateRange } from "./ciaraBudgetSync";

describe("syncDateRange", () => {
  it("今月の 1 日〜来月の末日（年またぎ）", () => {
    const dates = syncDateRange("2026-12-15");
    assert.equal(dates[0], "2026-12-01");
    assert.equal(dates[dates.length - 1], "2027-01-31");
    assert.equal(dates.length, 62);
  });
});

describe("parseCiaraBudgetResponse", () => {
  const dates = ["2026-11-01", "2026-11-02"];
  it("正しい返事を読む（2 桁に丸める・null は予算なし）", () => {
    const r = parseCiaraBudgetResponse(
      { ok: true, stores: [{ shopifyLocationId: "123", storeName: "渋谷", days: [{ date: "2026-11-01", amount: 33333.333 }, { date: "2026-11-02", amount: null }] }] },
      dates,
    );
    assert.deepEqual(r, { ok: true, stores: [{ shopifyLocationId: "123", storeName: "渋谷", days: [{ date: "2026-11-01", amount: 33333.33 }, { date: "2026-11-02", amount: null }] }] });
  });
  it("形の違い・範囲外の日・負の金額は全体を断る", () => {
    assert.equal(parseCiaraBudgetResponse({ ok: false }, dates).ok, false);
    assert.equal(parseCiaraBudgetResponse({ ok: true, stores: [{ shopifyLocationId: "gid://x", days: [] }] }, dates).ok, false);
    assert.equal(parseCiaraBudgetResponse({ ok: true, stores: [{ shopifyLocationId: "1", days: [{ date: "2026-12-01", amount: 1 }] }] }, dates).ok, false);
    assert.equal(parseCiaraBudgetResponse({ ok: true, stores: [{ shopifyLocationId: "1", days: [{ date: "2026-11-01", amount: -1 }] }] }, dates).ok, false);
    assert.equal(parseCiaraBudgetResponse({ ok: true, stores: [{ shopifyLocationId: "1", days: [{ date: "2026-11-01", amount: "1" }] }] }, dates).ok, false);
  });
});

describe("diffSyncedStore", () => {
  it("ciara-system の値に合わせる（追加・変更・削除）。同じ値と返事に無い日は変えない", () => {
    const changes = diffSyncedStore(
      { "2026-11-01": 100, "2026-11-02": 200, "2026-11-03": 300, "2026-11-09": 999 },
      [
        { date: "2026-11-01", amount: 100 },
        { date: "2026-11-02", amount: 250 },
        { date: "2026-11-03", amount: null },
        { date: "2026-11-04", amount: 400 },
      ],
    );
    assert.deepEqual(changes, [
      { date: "2026-11-02", before: 200, after: 250, kind: "update" },
      { date: "2026-11-03", before: 300, after: null, kind: "remove" },
      { date: "2026-11-04", before: null, after: 400, kind: "add" },
    ]);
  });
});
