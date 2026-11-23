import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processBackfillStep, type BackfillStore } from "./backfillQueue.server";
import { newRun, type BackfillRun } from "../utils/backfillRun";

function memoryStore(initial: BackfillRun | null) {
  const state = { run: initial, stop: null as string | null, writes: 0 };
  const store: BackfillStore = {
    readRun: async () => (state.run ? structuredClone(state.run) : null),
    writeRun: async (_shopId, run) => { state.run = structuredClone(run); state.writes++; },
    stopRequested: async (_shopId, runId) => state.stop === runId,
  };
  return { state, store };
}

const job = { shopDomain: "example.myshopify.com", shopId: "s1", runId: "r1" };
const run = () => newRun({ runId: "r1", locationId: "gid://shopify/Location/1", locationName: "本店", month: "2026-11", today: "2026-11-02", now: "t0" });

function deps(store: BackfillStore, opts: { cached?: string[]; fail?: string[]; adminFails?: boolean; computed?: string[] } = {}) {
  return {
    store,
    now: () => "t1",
    hasCache: async (_s: string, _l: string, d: string) => (opts.cached ?? []).includes(d),
    getAdmin: async () => {
      if (opts.adminFails) throw new Error("token");
      return {} as never;
    },
    compute: async (_a: unknown, _s: string, _l: string, _n: string, d: string) => {
      if ((opts.fail ?? []).includes(d)) throw new Error(`失敗 ${d}`);
      opts.computed?.push(d);
      return {};
    },
  };
}

describe("processBackfillStep", () => {
  it("1 日ずつ取り込み、取込済みの日は飛ばし、最後に done になる", async () => {
    const { state, store } = memoryStore(run());
    const computed: string[] = [];
    const d = deps(store, { cached: ["2026-11-01"], computed });
    assert.equal(await processBackfillStep(job, d), true);
    assert.equal(state.run!.days[0].status, "skipped");
    assert.equal(await processBackfillStep(job, d), false);
    assert.equal(state.run!.days[1].status, "done");
    assert.equal(state.run!.state, "done");
    assert.deepEqual(computed, ["2026-11-02"]);
  });

  it("その日の集計の失敗は error にして次の日へ進む", async () => {
    const { state, store } = memoryStore(run());
    assert.equal(await processBackfillStep(job, deps(store, { fail: ["2026-11-01"] })), true);
    assert.equal(state.run!.days[0].status, "error");
    assert.equal(state.run!.days[0].reason, "失敗 2026-11-01");
  });

  it("Shopify に入れないときは投げ（キューがやり直す）、その日は processing のまま", async () => {
    const { state, store } = memoryStore(run());
    await assert.rejects(processBackfillStep(job, deps(store, { adminFails: true })));
    assert.equal(state.run!.days[0].status, "processing");
    assert.equal(state.run!.state, "running");
  });

  it("止める知らせがあれば何も取り込まず stopped にする", async () => {
    const { state, store } = memoryStore(run());
    state.stop = "r1";
    const computed: string[] = [];
    assert.equal(await processBackfillStep(job, deps(store, { computed })), false);
    assert.equal(state.run!.state, "stopped");
    assert.deepEqual(computed, []);
  });

  it("取り込み中に止められたら、その日の結果だけ入れて次を積まない", async () => {
    const { state, store } = memoryStore(run());
    const d = deps(store);
    d.compute = async () => { state.run = { ...state.run!, state: "stopped" }; state.stop = "r1"; return {}; };
    assert.equal(await processBackfillStep(job, d), false);
    assert.equal(state.run!.state, "stopped");
    assert.equal(state.run!.days[0].status, "done");
  });

  it("別の取り込みに替わっていたら何もしない", async () => {
    const { state, store } = memoryStore({ ...run(), runId: "other" });
    assert.equal(await processBackfillStep(job, deps(store)), false);
    assert.equal(state.writes, 0);
  });
});
