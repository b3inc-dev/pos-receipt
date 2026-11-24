import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CIARA_VISIT_SYNC_DAYS,
  parseCiaraVisitResponse,
  pickDisplayedVisitors,
  planCiaraMirror,
  splitVisitKey,
  visitKey,
  visitSyncDateRange,
  type RemoteVisit,
  type StoredCiaraVisit,
} from "./ciaraVisitSync";
import { footfallReadDateRange } from "./ciaraFootfallRead";

const G = "gid://shopify/Location/11";
const k = (d: string) => visitKey(G, d);

describe("visitSyncDateRange", () => {
  it("今日を含めて前の 35 日を古い順に（月・年またぎ）", () => {
    const r = visitSyncDateRange("2026-01-10");
    assert.equal(r.length, CIARA_VISIT_SYNC_DAYS);
    assert.equal(r[0], "2025-12-07");
    assert.equal(r[r.length - 1], "2026-01-10");
  });
});

describe("visitKey", () => {
  it("店と日に分け直せる", () => {
    assert.deepEqual(splitVisitKey(k("2026-11-23")), { locationGid: G, date: "2026-11-23" });
  });
});

describe("parseCiaraVisitResponse", () => {
  const dates = ["2026-11-22", "2026-11-23"];
  it("正しい返事を読む（人が入れた時刻が空の日もある）", () => {
    const r = parseCiaraVisitResponse(
      {
        ok: true,
        stores: [{
          shopifyLocationId: "11",
          storeName: "梅田",
          days: [
            { date: "2026-11-22", visitCount: 100, reportedAt: null },
            { date: "2026-11-23", visitCount: 120, reportedAt: "2026-11-23T12:00:00.000Z" },
          ],
        }],
      },
      dates,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.stores[0].days[0].reportedAt, null);
      assert.equal(r.stores[0].days[1].visitCount, 120);
    }
  });
  it("範囲の外の日・負の数・時刻の誤り・形の誤りは何も読まない", () => {
    const store = (day: object) => ({ ok: true, stores: [{ shopifyLocationId: "11", storeName: "梅田", days: [day] }] });
    assert.equal(parseCiaraVisitResponse(store({ date: "2026-11-24", visitCount: 1, reportedAt: null }), dates).ok, false);
    assert.equal(parseCiaraVisitResponse(store({ date: "2026-11-23", visitCount: -1, reportedAt: null }), dates).ok, false);
    assert.equal(parseCiaraVisitResponse(store({ date: "2026-11-23", visitCount: 1, reportedAt: "x" }), dates).ok, false);
    assert.equal(parseCiaraVisitResponse({ ok: false }, dates).ok, false);
  });
});

describe("planCiaraMirror", () => {
  const remote = (visitCount: number, reportedAt: string | null): RemoteVisit => ({ visitCount, reportedAt });
  const stored = (visitors: number, reportedAt: string | null): StoredCiaraVisit => ({ visitors, reportedAt });

  it("新しい日は書く・同じ数と時刻は何もしない・数か時刻が変われば書く（前の数つき）", () => {
    const plan = planCiaraMirror(
      new Map([
        [k("2026-11-21"), stored(50, "2026-11-21T10:00:00.000Z")],
        [k("2026-11-22"), stored(60, null)],
        [k("2026-11-23"), stored(70, "2026-11-23T10:00:00.000Z")],
      ]),
      new Map([
        [k("2026-11-21"), remote(50, "2026-11-21T10:00:00.000Z")],
        [k("2026-11-22"), remote(66, null)],
        [k("2026-11-23"), remote(70, "2026-11-23T11:00:00.000Z")],
        [k("2026-11-24"), remote(80, null)],
      ]),
    );
    assert.deepEqual(plan.upserts, [
      { key: k("2026-11-22"), before: 60, visitCount: 66, reportedAt: null },
      { key: k("2026-11-23"), before: 70, visitCount: 70, reportedAt: "2026-11-23T11:00:00.000Z" },
      { key: k("2026-11-24"), before: null, visitCount: 80, reportedAt: null },
    ]);
    assert.deepEqual(plan.deletes, []);
  });

  it("ciara-system から消えた日は写しからも消す", () => {
    const plan = planCiaraMirror(new Map([[k("2026-11-21"), stored(50, null)]]), new Map());
    assert.deepEqual(plan, { upserts: [], deletes: [{ key: k("2026-11-21"), before: 50 }] });
  });
});

describe("pickDisplayedVisitors", () => {
  const pos = (visitors: number, enteredAt: string) => ({ visitors, enteredAt });
  const ciara = (visitors: number, reportedAt: string | null): StoredCiaraVisit => ({ visitors, reportedAt });

  it("片方だけならその数。どちらも無ければ空", () => {
    assert.equal(pickDisplayedVisitors(null, null), null);
    assert.deepEqual(pickDisplayedVisitors(pos(50, "2026-11-21T10:00:00Z"), null), { visitors: 50, from: "pos" });
    assert.deepEqual(pickDisplayedVisitors(null, ciara(60, null)), { visitors: 60, from: "ciara" });
  });

  it("人があとから入れたほう。同じ時刻なら ciara-system の数。ciara-system の時刻が空なら POS の数", () => {
    assert.deepEqual(pickDisplayedVisitors(pos(50, "2026-11-21T10:00:00Z"), ciara(60, "2026-11-21T11:00:00Z")), { visitors: 60, from: "ciara" });
    assert.deepEqual(pickDisplayedVisitors(pos(50, "2026-11-21T12:00:00Z"), ciara(60, "2026-11-21T11:00:00Z")), { visitors: 50, from: "pos" });
    assert.deepEqual(pickDisplayedVisitors(pos(50, "2026-11-21T11:00:00Z"), ciara(60, "2026-11-21T11:00:00.000Z")), { visitors: 60, from: "ciara" });
    assert.deepEqual(pickDisplayedVisitors(pos(50, "2026-11-21T11:00:00Z"), ciara(60, null)), { visitors: 50, from: "pos" });
  });

  it("0 は 0 として出す", () => {
    assert.deepEqual(pickDisplayedVisitors(pos(0, "2026-11-21T12:00:00Z"), ciara(60, "2026-11-21T11:00:00Z")), { visitors: 0, from: "pos" });
  });
});

describe("footfallReadDateRange", () => {
  it("両端を含め 62 日まで", () => {
    assert.deepEqual(footfallReadDateRange("2026-11-01", "2026-11-30"), { ok: true, from: "2026-11-01", to: "2026-11-30" });
    assert.equal(footfallReadDateRange("2026-11-01", "2027-01-01").ok, true);
    assert.equal(footfallReadDateRange("2026-11-01", "2027-01-02").ok, false);
    assert.equal(footfallReadDateRange("2026-11-31", "2026-12-01").ok, false);
    assert.equal(footfallReadDateRange("2026-12-01", "2026-11-01").ok, false);
    assert.equal(footfallReadDateRange(null, "2026-11-01").ok, false);
  });
});
