/**
 * 裏で「店×日」を数えるキューの 1 ジョブ分（processSalesSummaryFillJob）と、
 * 読み込みをまたいだ「数えている途中」への相乗り（shareInFlight）。
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

mock.module(new URL("../db.server.ts", import.meta.url).href, { defaultExport: {} });
mock.module(new URL("./salesSummaryEngine.server.ts", import.meta.url).href, {
  namedExports: { computeAndCacheDailySummary: async () => ({}) },
});

const { processSalesSummaryFillJob, fillSingletonKey } = await import("./salesSummaryFillQueue.server.ts");
const { shareInFlight, __resetSalesSummaryInFlightForTest } = await import("../utils/salesSummaryLoadShare.server.ts");
const { isSalesSummaryComputeRecentlyFailed, __resetSalesSummaryComputeFailuresForTest } = await import(
  "../utils/salesSummaryPeriodCache.server.ts"
);

const LOC = "gid://shopify/Location/1002";
const job = (day: string) => ({ shopDomain: "x.myshopify.com", shopId: "shop1", locationGid: LOC, locationName: "北千住", day });

function deps(opts: { cached: boolean; fail?: boolean; calls: string[] }) {
  return {
    getAdmin: async () => ({}) as never,
    hasCache: async () => opts.cached,
    compute: async (_a: unknown, _s: string, loc: string, _n: string, day: string) => {
      opts.calls.push(`${loc}|${day}`);
      if (opts.fail) throw new Error("Throttled");
      return {};
    },
    today: async () => "2026-11-24",
  };
}

test("過去の日で保存があれば数えない。無ければ数える。今日は保存があっても数え直す", async () => {
  __resetSalesSummaryInFlightForTest();
  const calls: string[] = [];
  assert.equal(await processSalesSummaryFillJob(job("2026-11-10"), deps({ cached: true, calls })), "skipped");
  assert.equal(await processSalesSummaryFillJob(job("2026-11-10"), deps({ cached: false, calls })), "done");
  assert.equal(await processSalesSummaryFillJob(job("2026-11-24"), deps({ cached: true, calls })), "done");
  assert.deepEqual(calls, [`${LOC}|2026-11-10`, `${LOC}|2026-11-24`]);
});

test("数えるのに失敗したら投げる（キューがやり直す）。失敗の印を付け、ログに出す", async () => {
  __resetSalesSummaryInFlightForTest();
  __resetSalesSummaryComputeFailuresForTest();
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  try {
    await assert.rejects(processSalesSummaryFillJob(job("2026-11-11"), deps({ cached: false, fail: true, calls: [] })));
  } finally {
    console.warn = orig;
  }
  assert.equal(isSalesSummaryComputeRecentlyFailed(`loc|shop1|${LOC}|2026-11-11`), true);
  assert.ok(warns.some((w) => w.includes("location=1002") && w.includes("day=2026-11-11")));
  // 次に成功したら印を外す
  await processSalesSummaryFillJob(job("2026-11-11"), deps({ cached: false, calls: [] }));
  assert.equal(isSalesSummaryComputeRecentlyFailed(`loc|shop1|${LOC}|2026-11-11`), false);
});

test("同じ「店×日」は 1 つしか積まない鍵（ショップ・店・日）", () => {
  assert.equal(fillSingletonKey("shop1", LOC, "2026-11-10"), `shop1|${LOC}|2026-11-10`);
});

test("数えている途中の同じ計算には相乗りし、終わったら外す（結果を使い回さない）", async () => {
  __resetSalesSummaryInFlightForTest();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  };
  const [a, b] = await Promise.all([shareInFlight("k", fn), shareInFlight("k", fn)]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(await shareInFlight("k", fn), 2);
  await assert.rejects(shareInFlight("bad", async () => { throw new Error("x"); }));
  assert.equal(await shareInFlight("bad", async () => "ok"), "ok");
});
