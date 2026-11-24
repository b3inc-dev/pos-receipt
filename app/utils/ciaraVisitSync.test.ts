import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CIARA_VISIT_SYNC_DAYS,
  UNKNOWN_ENTERED_AT,
  parseCiaraVisitResponse,
  planVisitPull,
  splitVisitKey,
  visitKey,
  visitSyncDateRange,
  type LocalVisit,
  type RemoteVisit,
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

describe("planVisitPull", () => {
  const pos = (visitors: number, enteredAt: string): LocalVisit => ({ visitors, enteredAt, source: "pos" });
  const fromCiara = (visitors: number, enteredAt: string): LocalVisit => ({ visitors, enteredAt, source: "ciara" });
  const remote = (visitCount: number, reportedAt: string | null): RemoteVisit => ({ visitCount, reportedAt });

  it("ciara-system にだけある日は入れる（時刻が空なら古い時刻で入れる）", () => {
    const plan = planVisitPull(new Map(), new Map([
      [k("2026-11-21"), remote(50, null)],
      [k("2026-11-22"), remote(60, "2026-11-22T10:00:00Z")],
    ]));
    assert.deepEqual(plan, [
      { key: k("2026-11-21"), visitCount: 50, enteredAt: UNKNOWN_ENTERED_AT },
      { key: k("2026-11-22"), visitCount: 60, enteredAt: "2026-11-22T10:00:00Z" },
    ]);
  });

  it("同じ数は何もしない。POS にだけある日も何もしない（外へは書かない）", () => {
    const plan = planVisitPull(
      new Map([
        [k("2026-11-21"), pos(50, "2026-11-21T10:00:00Z")],
        [k("2026-11-22"), pos(60, "2026-11-22T10:00:00Z")],
      ]),
      new Map([[k("2026-11-21"), remote(50, "2026-11-21T11:00:00Z")]]),
    );
    assert.deepEqual(plan, []);
  });

  it("POS の数は、ciara-system で人があとから入れたときだけ入れる（同じ時刻・時刻が空なら POS のまま）", () => {
    const plan = planVisitPull(
      new Map([
        [k("2026-11-21"), pos(50, "2026-11-21T12:00:00Z")],
        [k("2026-11-22"), pos(60, "2026-11-22T09:00:00Z")],
        [k("2026-11-23"), pos(70, "2026-11-23T10:00:00Z")],
        [k("2026-11-24"), pos(80, "2026-11-24T10:00:00Z")],
      ]),
      new Map([
        [k("2026-11-21"), remote(55, "2026-11-21T11:00:00Z")],
        [k("2026-11-22"), remote(66, "2026-11-22T10:00:00Z")],
        [k("2026-11-23"), remote(77, "2026-11-23T10:00:00Z")],
        [k("2026-11-24"), remote(88, null)],
      ]),
    );
    assert.deepEqual(plan.map((v) => [v.key, v.visitCount]), [[k("2026-11-22"), 66]]);
  });

  it("前に ciara-system から入れた数は、ciara-system の今の数に合わせる", () => {
    const plan = planVisitPull(
      new Map([[k("2026-11-22"), fromCiara(60, "2026-11-22T10:00:00Z")]]),
      new Map([[k("2026-11-22"), remote(65, null)]]),
    );
    assert.deepEqual(plan.map((v) => v.visitCount), [65]);
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
