import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asRun, daysInMonth, finishedIfNoneLeft, newRun, nextDay, resumedRun, runCounts, withDayResult } from "./backfillRun";

const base = () => newRun({ runId: "r1", locationId: "gid://shopify/Location/1", locationName: "本店", month: "2026-11", today: "2026-11-03", now: "t0" });

describe("daysInMonth", () => {
  it("今日より先の日は入れない", () => {
    assert.deepEqual(daysInMonth("2026-11", "2026-11-03"), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  });
  it("過去の月は月末まで（2 月のうるう年も）", () => {
    assert.equal(daysInMonth("2024-02", "2026-11-22").length, 29);
  });
  it("おかしな月は空", () => {
    assert.deepEqual(daysInMonth("2026-13", "2026-11-22"), []);
    assert.deepEqual(daysInMonth("x", "2026-11-22"), []);
  });
});

describe("進み具合", () => {
  it("1 日ずつ進み、全部済んだら done", () => {
    let run = base();
    assert.equal(run.state, "running");
    for (const status of ["done", "skipped", "error"] as const) {
      const day = nextDay(run)!;
      run = withDayResult(run, day.targetDate, "processing", undefined, "t1");
      run = withDayResult(run, day.targetDate, status, status === "error" ? "失敗" : undefined, "t2");
      run = finishedIfNoneLeft(run, "t3");
    }
    assert.equal(nextDay(run), null);
    assert.equal(run.state, "done");
    assert.deepEqual(runCounts(run), { total: 3, processed: 3, errors: 1 });
  });

  it("途中で止まった日（processing）を先にもう一度取り込む", () => {
    let run = withDayResult(base(), "2026-11-02", "processing", undefined, "t1");
    assert.equal(nextDay(run)?.targetDate, "2026-11-02");
  });

  it("止めた状態は 1 日の結果を入れても変わらない", () => {
    const run = withDayResult({ ...base(), state: "stopped" }, "2026-11-01", "done", undefined, "t1");
    assert.equal(run.state, "stopped");
    assert.equal(finishedIfNoneLeft(run, "t2").state, "stopped");
  });

  it("続きから再開は失敗と途中の日だけを戻す", () => {
    let run = withDayResult(base(), "2026-11-01", "done", undefined, "t1");
    run = withDayResult(run, "2026-11-02", "error", "x", "t1");
    run = withDayResult(run, "2026-11-03", "processing", undefined, "t1");
    run = resumedRun({ ...run, state: "stopped" }, "t2");
    assert.equal(run.state, "running");
    assert.deepEqual(run.days.map((d) => d.status), ["done", "pending", "pending"]);
    assert.equal(run.days[1].reason, undefined);
  });

  it("壊れた値は進み具合として扱わない", () => {
    assert.equal(asRun(null), null);
    assert.equal(asRun({ runId: "a" }), null);
    assert.equal(asRun({ ...base(), state: "x" }), null);
    assert.ok(asRun(base()));
  });
});
