import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCiaraSyncScheduler, createQueueWithRetry, type SchedulerBoss } from "./ciaraSyncScheduler.server";

/** 列を作るのが failTimes 回失敗する pg-boss のまね */
function fakeBoss(opts: { createFails?: number; createThrowsButExists?: boolean; scheduleFails?: boolean } = {}) {
  const calls: string[] = [];
  let queueExists = false;
  let createFails = opts.createFails ?? 0;
  const boss: SchedulerBoss = {
    on: () => undefined,
    start: async () => { calls.push("start"); },
    stop: async () => { calls.push("stop"); },
    createQueue: async () => {
      calls.push("createQueue");
      if (opts.createThrowsButExists) { queueExists = true; throw new Error("duplicate"); }
      if (createFails > 0) { createFails--; throw new Error("deadlock detected"); }
      queueExists = true;
    },
    getQueue: async () => (queueExists ? { name: "q" } : null),
    schedule: async () => {
      calls.push("schedule");
      if (!queueExists) throw new Error("Queue q not found");
      if (opts.scheduleFails) throw new Error("schedule broke");
    },
    work: async () => { calls.push("work"); },
  };
  return { boss, calls };
}

const quiet = <T>(fn: () => Promise<T>) => async () => {
  const { warn, error, log } = console;
  console.warn = console.error = console.log = () => {};
  try { return await fn(); } finally { Object.assign(console, { warn, error, log }); }
};

const noSleep = async () => {};

describe("createQueueWithRetry", () => {
  it("作れたら 1 回で終わる", async () => {
    const { boss, calls } = fakeBoss();
    await createQueueWithRetry(boss, "q", {}, { tag: "t", sleep: noSleep });
    assert.deepEqual(calls, ["createQueue"]);
  });

  it("失敗しても列があれば進む（もう作られていた）", quiet(async () => {
    const { boss } = fakeBoss({ createThrowsButExists: true });
    await createQueueWithRetry(boss, "q", {}, { tag: "t", sleep: noSleep });
  }));

  it("ぶつかって失敗したら、やり直して作る", quiet(async () => {
    const { boss, calls } = fakeBoss({ createFails: 2 });
    await createQueueWithRetry(boss, "q", {}, { tag: "t", attempts: 3, sleep: noSleep });
    assert.equal(calls.filter((c) => c === "createQueue").length, 3);
  }));

  it("やり直しても作れなければ、理由つきで失敗にする（捨てない）", quiet(async () => {
    const { boss } = fakeBoss({ createFails: 5 });
    await assert.rejects(
      createQueueWithRetry(boss, "q", {}, { tag: "t", attempts: 3, sleep: noSleep }),
      /queue q could not be created: deadlock detected/,
    );
  }));
});

describe("createCiaraSyncScheduler", () => {
  const base = { tag: "t", queue: "q", cron: "7 * * * *", work: async () => {}, sleep: noSleep, restartDelayMs: 0 };

  it("準備が無ければ始めない（状態は off）", async () => {
    let made = 0;
    const s = createCiaraSyncScheduler({ ...base, ready: () => false, createBoss: () => { made++; return fakeBoss().boss; } });
    assert.equal(await s.ensure(), null);
    assert.equal(made, 0);
    assert.equal(s.status().state, "off");
  });

  it("始まると running になり、2 回目は同じものを返す", quiet(async () => {
    let made = 0;
    const { boss, calls } = fakeBoss();
    const s = createCiaraSyncScheduler({ ...base, ready: () => true, createBoss: () => { made++; return boss; } });
    const p = s.ensure();
    assert.equal(s.status().state, "starting");
    assert.equal(await p, boss);
    assert.equal(await s.ensure(), boss);
    assert.equal(made, 1);
    assert.equal(s.status().state, "running");
    assert.deepEqual(calls, ["start", "createQueue", "schedule", "work"]);
  }));

  it("列が作れなければ failed にし、止めて、次の呼び出しでもう一度始める", quiet(async () => {
    const first = fakeBoss({ createFails: 99 });
    const second = fakeBoss();
    const bosses = [first.boss, second.boss];
    const s = createCiaraSyncScheduler({ ...base, ready: () => true, queueAttempts: 2, createBoss: () => bosses.shift()! });
    assert.equal(await s.ensure(), null);
    assert.equal(s.status().state, "failed");
    assert.match(s.status().error ?? "", /could not be created/);
    assert.ok(first.calls.includes("stop"), "失敗した pg-boss は止める");
    assert.ok(!first.calls.includes("schedule"), "列が無いまま schedule しない");
    // 前は startPromise が null で決まって二度と始まらなかった
    assert.equal(await s.ensure(), second.boss);
    assert.equal(s.status().state, "running");
  }));

  it("schedule が失敗しても failed にして、やり直せる", quiet(async () => {
    const bosses = [fakeBoss({ scheduleFails: true }).boss, fakeBoss().boss];
    const s = createCiaraSyncScheduler({ ...base, ready: () => true, createBoss: () => bosses.shift()! });
    assert.equal(await s.ensure(), null);
    assert.equal(s.status().state, "failed");
    assert.ok(await s.ensure());
    assert.equal(s.status().state, "running");
  }));

  it("失敗のあと、時間をおいて自動でもう一度始める", quiet(async () => {
    const bosses = [fakeBoss({ createFails: 99 }).boss, fakeBoss().boss];
    const s = createCiaraSyncScheduler({ ...base, ready: () => true, queueAttempts: 1, restartDelayMs: 5, createBoss: () => bosses.shift()! });
    await s.ensure();
    assert.equal(s.status().state, "failed");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(s.status().state, "running");
  }));
});
