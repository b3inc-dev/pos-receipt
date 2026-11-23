import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CIARA_VISIT_SYNC_DAYS,
  parseCiaraVisitResponse,
  planVisitSync,
  splitVisitKey,
  visitKey,
  visitSyncDateRange,
  type LocalVisit,
  type RemoteVisit,
} from "./ciaraVisitSync";

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
  it("正しい返事を読む", () => {
    const r = parseCiaraVisitResponse(
      { ok: true, receiveEnabled: true, stores: [{ shopifyLocationId: "11", storeName: "梅田", days: [{ date: "2026-11-23", visitCount: 120, updatedAt: "2026-11-23T12:00:00.000Z" }] }] },
      dates,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.receiveEnabled, true);
      assert.equal(r.stores[0].days[0].visitCount, 120);
    }
  });
  it("範囲の外の日・負の数・時刻の誤り・形の誤りは何も読まない", () => {
    const store = (day: object) => ({ ok: true, stores: [{ shopifyLocationId: "11", storeName: "梅田", days: [day] }] });
    assert.equal(parseCiaraVisitResponse(store({ date: "2026-11-24", visitCount: 1, updatedAt: "2026-11-23T00:00:00Z" }), dates).ok, false);
    assert.equal(parseCiaraVisitResponse(store({ date: "2026-11-23", visitCount: -1, updatedAt: "2026-11-23T00:00:00Z" }), dates).ok, false);
    assert.equal(parseCiaraVisitResponse(store({ date: "2026-11-23", visitCount: 1, updatedAt: "x" }), dates).ok, false);
    assert.equal(parseCiaraVisitResponse({ ok: false }, dates).ok, false);
  });
  it("受け取りの印が無ければオフとして読む", () => {
    const r = parseCiaraVisitResponse({ ok: true, stores: [] }, dates);
    assert.equal(r.ok && r.receiveEnabled, false);
  });
});

describe("planVisitSync", () => {
  const pos = (visitors: number, enteredAt: string, pushedAt: string | null = null): LocalVisit => ({ visitors, enteredAt, source: "pos", pushedAt });
  const fromCiara = (visitors: number, enteredAt: string): LocalVisit => ({ visitors, enteredAt, source: "ciara", pushedAt: enteredAt });
  const remote = (visitCount: number, updatedAt: string): RemoteVisit => ({ visitCount, updatedAt });

  it("ciara-system にだけある日はこのアプリへ、POS にだけある日は ciara-system へ", () => {
    const plan = planVisitSync(
      new Map([[k("2026-11-21"), pos(50, "2026-11-21T10:00:00Z")]]),
      new Map([[k("2026-11-22"), remote(60, "2026-11-22T10:00:00Z")]]),
    );
    assert.deepEqual(plan.toLocal, [{ key: k("2026-11-22"), visitCount: 60, updatedAt: "2026-11-22T10:00:00Z" }]);
    assert.deepEqual(plan.toRemote, [{ key: k("2026-11-21"), visitCount: 50, enteredAt: "2026-11-21T10:00:00Z" }]);
  });

  it("同じ数は何もしない。POS の数で送っていなければ印だけ付ける（往復しない）", () => {
    const plan = planVisitSync(
      new Map([
        [k("2026-11-21"), pos(50, "2026-11-21T10:00:00Z")],
        [k("2026-11-22"), pos(60, "2026-11-22T10:00:00Z", "2026-11-22T10:01:00Z")],
        [k("2026-11-23"), fromCiara(70, "2026-11-23T10:00:00Z")],
      ]),
      new Map([
        [k("2026-11-21"), remote(50, "2026-11-21T10:05:00Z")],
        [k("2026-11-22"), remote(60, "2026-11-22T10:01:00Z")],
        [k("2026-11-23"), remote(70, "2026-11-23T10:00:00Z")],
      ]),
    );
    assert.deepEqual(plan.toLocal, []);
    assert.deepEqual(plan.toRemote, []);
    assert.deepEqual(plan.markPushed, [k("2026-11-21")]);
  });

  it("違う数はあとから入れたほう（同じ時刻なら ciara-system）", () => {
    const plan = planVisitSync(
      new Map([
        [k("2026-11-21"), pos(50, "2026-11-21T12:00:00Z")], // POS があと
        [k("2026-11-22"), pos(60, "2026-11-22T09:00:00Z")], // ciara-system があと
        [k("2026-11-23"), pos(70, "2026-11-23T10:00:00Z")], // 同じ時刻
      ]),
      new Map([
        [k("2026-11-21"), remote(55, "2026-11-21T11:00:00Z")],
        [k("2026-11-22"), remote(66, "2026-11-22T10:00:00Z")],
        [k("2026-11-23"), remote(77, "2026-11-23T10:00:00Z")],
      ]),
    );
    assert.deepEqual(plan.toRemote.map((v) => v.key), [k("2026-11-21")]);
    assert.deepEqual(plan.toLocal.map((v) => [v.key, v.visitCount]), [[k("2026-11-22"), 66], [k("2026-11-23"), 77]]);
  });

  it("ciara-system から入れた数は送り返さない（ciara-system で直されていたら取り直す）", () => {
    const plan = planVisitSync(
      new Map([
        [k("2026-11-21"), fromCiara(50, "2026-11-21T10:00:00Z")],
        [k("2026-11-22"), fromCiara(60, "2026-11-22T10:00:00Z")],
      ]),
      new Map([[k("2026-11-22"), remote(65, "2026-11-22T11:00:00Z")]]),
    );
    assert.deepEqual(plan.toRemote, []);
    assert.deepEqual(plan.toLocal.map((v) => v.visitCount), [65]);
  });
});
