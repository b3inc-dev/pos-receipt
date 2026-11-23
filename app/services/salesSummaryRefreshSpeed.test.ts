/**
 * 売上サマリーの表示を速くする直しの試験（数え方は変えず、数え直す回数と順番だけを変える）。
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  datesStillNeedingRefresh,
  markRefreshCompleted,
  resetRefreshCoalesceForTest,
} from "./salesSummaryRefreshCoalesce.server";
import {
  runAsSettlementBackground,
  runSettlementGraphqlSerial,
} from "../lib/shopifyGraphqlThrottle.server";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("裏の再計算をまとめる（datesStillNeedingRefresh）", () => {
  beforeEach(() => resetRefreshCoalesceForTest());

  it("ジョブより後に始まって終わった再計算がある日は、数え直さない", () => {
    const job = new Date("2026-11-23T10:00:00Z");
    markRefreshCompleted("shop1", ["2026-11-23"], new Date("2026-11-23T10:00:05Z"));
    assert.deepEqual(datesStillNeedingRefresh("shop1", ["2026-11-23"], job), []);
  });

  it("ジョブより前に始まった再計算では済ませない（その再計算は新しい注文を読んでいないかもしれない）", () => {
    const job = new Date("2026-11-23T10:00:05Z");
    markRefreshCompleted("shop1", ["2026-11-23"], new Date("2026-11-23T10:00:00Z"));
    assert.deepEqual(datesStillNeedingRefresh("shop1", ["2026-11-23"], job), ["2026-11-23"]);
  });

  it("同じ時刻に始まったものも済ませない（境目は数え直す側に倒す）", () => {
    const t = new Date("2026-11-23T10:00:00Z");
    markRefreshCompleted("shop1", ["2026-11-23"], t);
    assert.deepEqual(datesStillNeedingRefresh("shop1", ["2026-11-23"], t), ["2026-11-23"]);
  });

  it("日ごと・店ごとに分けて覚える", () => {
    const job = new Date("2026-11-23T10:00:00Z");
    markRefreshCompleted("shop1", ["2026-11-23"], new Date("2026-11-23T10:00:05Z"));
    assert.deepEqual(
      datesStillNeedingRefresh("shop1", ["2026-11-22", "2026-11-23"], job),
      ["2026-11-22"],
    );
    assert.deepEqual(datesStillNeedingRefresh("shop2", ["2026-11-23"], job), ["2026-11-23"]);
  });

  it("積まれた時刻が分からないジョブ（同期の Webhook）は、いつも数え直す", () => {
    markRefreshCompleted("shop1", ["2026-11-23"], new Date());
    assert.deepEqual(datesStillNeedingRefresh("shop1", ["2026-11-23"], null), ["2026-11-23"]);
  });

  it("新しい開始時刻だけを残す（古い時刻で上書きしない）", () => {
    const job = new Date("2026-11-23T10:00:03Z");
    markRefreshCompleted("shop1", ["2026-11-23"], new Date("2026-11-23T10:00:05Z"));
    markRefreshCompleted("shop1", ["2026-11-23"], new Date("2026-11-23T10:00:01Z"));
    assert.deepEqual(datesStillNeedingRefresh("shop1", ["2026-11-23"], job), []);
  });
});

describe("精算系の集計の順番（runSettlementGraphqlSerial）", () => {
  it("同じ店では 1 件ずつ動かす（同時に 2 件動かない）", async () => {
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await wait(5);
      running -= 1;
    };
    await Promise.all([
      runSettlementGraphqlSerial("s-serial", task),
      runSettlementGraphqlSerial("s-serial", task),
      runAsSettlementBackground(() => runSettlementGraphqlSerial("s-serial", task)),
    ]);
    assert.equal(maxRunning, 1);
  });

  it("前の 1 件が失敗しても、次の 1 件は動く", async () => {
    const a = runSettlementGraphqlSerial("s-fail", async () => {
      await wait(2);
      throw new Error("boom");
    });
    const b = runSettlementGraphqlSerial("s-fail", async () => "ok");
    await assert.rejects(a, /boom/);
    assert.equal(await b, "ok");
  });

  it("待っている画面の集計を、裏の再計算より先に動かす", async () => {
    const order: string[] = [];
    const first = runSettlementGraphqlSerial("s-prio", async () => {
      await wait(5);
      order.push("first");
    });
    const bg = runAsSettlementBackground(() =>
      runSettlementGraphqlSerial("s-prio", async () => {
        order.push("background");
      }),
    );
    const ui = runSettlementGraphqlSerial("s-prio", async () => {
      order.push("screen");
    });
    await Promise.all([first, bg, ui]);
    assert.deepEqual(order, ["first", "screen", "background"]);
  });

  it("画面の集計が続けて来る短い間は、裏の再計算を割り込ませない", async () => {
    const order: string[] = [];
    // 画面の 1 件目
    await runSettlementGraphqlSerial("s-grace", async () => {
      order.push("screen1");
    });
    // 裏の再計算が積まれる
    const bg = runAsSettlementBackground(() =>
      runSettlementGraphqlSerial("s-grace", async () => {
        order.push("background");
      }),
    );
    // 画面の 2 件目は少しあとに来る（店ごとの間の DB 読みなど）
    await wait(30);
    const ui2 = runSettlementGraphqlSerial("s-grace", async () => {
      order.push("screen2");
    });
    await Promise.all([bg, ui2]);
    assert.deepEqual(order, ["screen1", "screen2", "background"]);
  });

  it("画面の集計が無ければ、裏の再計算はそのまま進む", async () => {
    const r = await runAsSettlementBackground(() =>
      runSettlementGraphqlSerial("s-bg-only", async () => 42),
    );
    assert.equal(r, 42);
  });
});
