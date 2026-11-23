/**
 * 売上サマリー（POS の期間・当月）:
 * - 出す店は店舗設定（Location.salesSummaryEnabled）だけで決まる。売上サマリー設定の「出す店」は読まない（T さん 2026-11-24）
 * - 保存の無い「店×日」は、決まった時間だけリクエストの中で数え、残りは裏のキューに積んで先に返す
 * - 読み込み（loadId）が違っても、数えている途中の同じ「店×日」は 1 回だけ数える
 * - 数えるのに失敗した「店×日」はログに出し、しばらくは開くたびに数え直さない
 * （Prisma・精算プレビュー・裏のキューだけ差し替える。npm test が --experimental-test-module-mocks を付ける）
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 裏で数えるキューが「使える」ことにする（キューそのものは下で差し替える）
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test";
delete process.env.SALES_SUMMARY_FILL_QUEUE;

const SHOP_ID = "shop1";
const TODAY = "2026-11-24";
const gid = (n: number) => `gid://shopify/Location/${n}`;

type Loc = { id: string; shopId: string; shopifyLocationGid: string; name: string; salesSummaryEnabled: boolean };
let locations: Loc[] = [];
let cacheRows: Array<{ shopId: string; locationId: string; targetDate: string; actual: number; orders: number; items: number; visitors: number | null; budget: number | null }> = [];
let settings: Record<string, unknown> = {};
let computeCalls: string[] = [];
let computeDelayMs = 0;
let computeFail: (loc: string, day: string) => boolean = () => false;
let enqueued: Array<{ shopDomain: string; items: Array<{ locationGid: string; day: string }> }> = [];
let enqueueResult: number | null = null;
let channels: Array<{ id: string; displayName: string; sourceNames: string[] }> = [];
let channelCache: Array<{ shopId: string; channelId: string; targetDate: string; actual: number; orders: number; items: number; budget: number | null }> = [];
let channelCalls: string[] = [];

function matchIn(value: string, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (typeof cond === "string") return value === cond;
  const c = cond as { in?: string[]; gte?: string; lte?: string; lt?: string };
  if (c.in && !c.in.includes(value)) return false;
  if (c.gte && value < c.gte) return false;
  if (c.lte && value > c.lte) return false;
  if (c.lt && value >= c.lt) return false;
  return true;
}

const prismaMock = {
  location: {
    findMany: async ({ where }: { where: { shopId: string; salesSummaryEnabled?: boolean } }) =>
      locations.filter(
        (l) => l.shopId === where.shopId && (where.salesSummaryEnabled === undefined || l.salesSummaryEnabled === where.salesSummaryEnabled),
      ),
    upsert: async () => ({}),
  },
  salesSummaryCacheDaily: {
    findMany: async ({ where }: { where: { shopId: string; locationId?: unknown; targetDate?: unknown } }) =>
      cacheRows.filter(
        (r) => r.shopId === where.shopId && matchIn(r.locationId, where.locationId) && matchIn(r.targetDate, where.targetDate),
      ),
  },
  salesChannelCacheDaily: {
    findMany: async ({ where }: { where: { shopId: string; channelId?: unknown; targetDate?: unknown } }) =>
      channelCache.filter(
        (r) => r.shopId === where.shopId && matchIn(r.channelId, where.channelId) && matchIn(r.targetDate, where.targetDate),
      ),
  },
};

mock.module(new URL("../db.server.ts", import.meta.url).href, { defaultExport: prismaMock });
mock.module(new URL("../utils/appSettings.server.ts", import.meta.url).href, {
  namedExports: {
    getAppSetting: async () => settings,
    SALES_SUMMARY_SETTINGS_KEY: "sales_summary_settings",
    mergeAndNormalizeSalesSummarySettings: (s?: Record<string, unknown>) => ({
      salesSummaryEnabled: true,
      visibleLocationIds: [],
      ...(s ?? {}),
    }),
  },
});
mock.module(new URL("./salesSummaryEngine.server.ts", import.meta.url).href, {
  namedExports: {
    computeAndCacheDailySummary: async (_admin: unknown, shopId: string, locGid: string, _name: string, day: string) => {
      computeCalls.push(`${locGid}|${day}`);
      if (computeDelayMs > 0) await new Promise((r) => setTimeout(r, computeDelayMs));
      if (computeFail(locGid, day)) throw new Error("Throttled");
      cacheRows = cacheRows.filter((r) => !(r.locationId === locGid && r.targetDate === day));
      cacheRows.push({ shopId, locationId: locGid, targetDate: day, actual: 1000, orders: 1, items: 1, visitors: null, budget: null });
      return {};
    },
  },
});
mock.module(new URL("./salesChannelEngine.server.ts", import.meta.url).href, {
  namedExports: {
    autoDiscoverChannels: async () => {},
    getEnabledSalesChannels: async () => channels,
    computeAndCacheChannelDailySummary: async (_a: unknown, shopId: string, chId: string, _n: string, _s: unknown, day: string) => {
      channelCalls.push(`${chId}|${day}`);
      if (computeDelayMs > 0) await new Promise((r) => setTimeout(r, computeDelayMs));
      channelCache.push({ shopId, channelId: chId, targetDate: day, actual: 500, orders: 1, items: 1, budget: null });
      return {};
    },
  },
});
mock.module(new URL("../utils/shopTimezone.server.ts", import.meta.url).href, {
  namedExports: {
    getShopTimezoneForDaily: async () => "Asia/Tokyo",
    getCalendarDateStringInTimeZone: () => TODAY,
    addCalendarDaysToIsoDate: (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10),
  },
});
mock.module(new URL("../utils/salesSummaryBudgetFromDb.server.ts", import.meta.url).href, {
  namedExports: {
    sumLocationBudgetsForPeriodBatch: async () => new Map(),
    sumChannelBudgetsForPeriodBatch: async () => new Map(),
  },
});
mock.module(new URL("./salesSummaryPeriodRollup.server.ts", import.meta.url).href, {
  namedExports: {
    tryLoadPeriodAggregatesFromRollup: async () => null,
    syncRollupsMatchingPeriodRequest: async () => {},
  },
});
mock.module(new URL("./salesSummaryFillQueue.server.ts", import.meta.url).href, {
  namedExports: {
    enqueueSalesSummaryFill: async (shopDomain: string, _shopId: string, items: Array<{ locationGid: string; day: string }>) => {
      enqueued.push({ shopDomain, items });
      return enqueueResult ?? items.length;
    },
  },
});

const { buildPeriodSalesSummaryPayload } = await import("./salesSummaryPeriodPayload.server.ts");
const { __resetSalesSummaryLoadShareForTest, __resetSalesSummaryInFlightForTest } = await import(
  "../utils/salesSummaryLoadShare.server.ts"
);
const {
  __resetSalesSummaryComputeFailuresForTest,
  __resetSalesSummaryFillQueueStateForTest,
  isSalesSummaryFillQueueUsable,
} = await import("../utils/salesSummaryPeriodCache.server.ts");
const { shareInFlight } = await import("../utils/salesSummaryLoadShare.server.ts");

const admin = { graphql: async () => ({ json: async () => ({ data: {} }) }) } as never;
const shop = { id: SHOP_ID };

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

async function settle() {
  // 前の試験で裏に積む処理（非同期）が終わるのを待つ
  await new Promise((r) => setTimeout(r, 60));
}

function reset(nLoc: number) {
  locations = Array.from({ length: nLoc }, (_, i) => ({
    id: `l${i}`,
    shopId: SHOP_ID,
    shopifyLocationGid: gid(1000 + i),
    name: `店${String(i).padStart(2, "0")}`,
    salesSummaryEnabled: true,
  }));
  cacheRows = [];
  settings = {};
  computeCalls = [];
  computeDelayMs = 0;
  computeFail = () => false;
  enqueued = [];
  enqueueResult = null;
  channels = [];
  channelCache = [];
  channelCalls = [];
  delete process.env.SALES_SUMMARY_FILL_QUEUE;
  __resetSalesSummaryFillQueueStateForTest();
  __resetSalesSummaryLoadShareForTest();
  __resetSalesSummaryInFlightForTest();
  __resetSalesSummaryComputeFailuresForTest();
}

function cacheAll(locs: Loc[], from: string, to: string) {
  for (const l of locs) for (const d of days(from, to)) {
    cacheRows.push({ shopId: SHOP_ID, locationId: l.shopifyLocationGid, targetDate: d, actual: 1000, orders: 1, items: 1, visitors: null, budget: null });
  }
}

test("出す店は店舗設定だけ: 売上サマリー設定の「出す店」に無い店も出る。店舗設定でオフの店は出ない", async () => {
  reset(13);
  locations[12].salesSummaryEnabled = false;
  // 前に保存した「出す店」は 10 店だけ（Ciara 2026-11-24 の形）
  settings = { visibleLocationIds: locations.slice(0, 10).map((l) => l.shopifyLocationGid) };
  cacheAll(locations, "2026-11-01", "2026-11-24");
  const p = await buildPeriodSalesSummaryPayload(admin, shop, { dateFrom: "2026-11-01", dateTo: "2026-11-23" });
  const shown = (p.rows as Array<{ locationId: string }>).map((r) => r.locationId).sort();
  assert.deepEqual(shown, locations.slice(0, 12).map((l) => l.shopifyLocationGid).sort());
  assert.equal(computeCalls.length, 0, "過去の日はすべて保存済みなので数えない");
  assert.equal(p.periodCachePartial, false);
});

test("時間を超えた「店×日」は数えずに先に返し、裏のキューに積む。今日の分を先に数える", async () => {
  reset(3);
  cacheAll(locations.slice(0, 2), "2026-11-01", "2026-11-23");
  // 3 店目だけ 11 月の保存が無い（あとから足した店）
  computeDelayMs = 25;
  const p = await buildPeriodSalesSummaryPayload(admin, shop, {
    dateFrom: "2026-11-01",
    dateTo: "2026-11-24",
    loadId: "load-aaaa01",
    computeTimeBudgetMs: 120,
    backgroundShopDomain: "x.myshopify.com",
  });
  // 今日（3 店）を先に数える
  assert.deepEqual(
    computeCalls.slice(0, 3).map((c) => c.split("|")[1]),
    [TODAY, TODAY, TODAY],
  );
  assert.ok(computeCalls.length < 3 + 23, `数えたのは ${computeCalls.length} 個（時間で止まる）`);
  assert.equal(p.periodCachePartial, true);
  const pending = p.pendingLocations ?? [];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].locationId, gid(1002));
  assert.equal(pending[0].locationName, "店02");
  assert.equal(pending[0].days, 3 + 23 - computeCalls.length);
  assert.equal(p.pendingComputeEstimate, pending[0].days);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].shopDomain, "x.myshopify.com");
  assert.equal(enqueued[0].items.length, pending[0].days);
  // 古い日から数えている（11/1 は数えた・積んだのは残りの新しい日）
  assert.ok(computeCalls.includes(`${gid(1002)}|2026-11-01`));
  assert.ok(enqueued[0].items.every((i) => i.locationGid === gid(1002) && i.day > "2026-11-01"));
  // 店の行は、保存済みの日の分だけで出す（数え終わった日だけの合計）
  const row = (p.rows as Array<{ locationId: string; orders: number }>).find((r) => r.locationId === gid(1002));
  assert.equal(row?.orders, computeCalls.filter((c) => c.startsWith(gid(1002))).length);
});

test("時間の決まりが無い呼び出し（管理画面・公開リンク）は今まで通り全部数え、キューには積まない", async () => {
  reset(2);
  const p = await buildPeriodSalesSummaryPayload(admin, shop, { dateFrom: "2026-11-01", dateTo: "2026-11-05" });
  assert.equal(computeCalls.length, 10);
  assert.equal(p.periodCachePartial, false);
  assert.equal(p.pendingLocations, undefined);
  assert.equal(enqueued.length, 0);
});

test("開き直しで並んだ読み込み（loadId が違う）は、同じ「店×日」を 1 回だけ数える", async () => {
  reset(4);
  computeDelayMs = 10;
  const opts = (loadId: string) => ({ dateFrom: "2026-11-01", dateTo: "2026-11-03", loadId });
  const [a, b, c] = await Promise.all([
    buildPeriodSalesSummaryPayload(admin, shop, opts("load-bbbb01")),
    buildPeriodSalesSummaryPayload(admin, shop, opts("load-bbbb02")),
    buildPeriodSalesSummaryPayload(admin, shop, opts("load-bbbb03")),
  ]);
  assert.equal(computeCalls.length, 4 * 3, `数えた回数 ${computeCalls.length}`);
  assert.equal(new Set(computeCalls).size, computeCalls.length);
  for (const p of [a, b, c]) assert.equal((p.totals as { orders: number }).orders, 12);
});

test("数えるのに失敗した「店×日」はログに出し、しばらくは数え直さない（裏で数える）", async () => {
  reset(2);
  computeFail = (loc, day) => loc === gid(1001) && day === "2026-11-02";
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    const opts = { dateFrom: "2026-11-01", dateTo: "2026-11-03", computeTimeBudgetMs: 60000, backgroundShopDomain: "x.myshopify.com" };
    const first = await buildPeriodSalesSummaryPayload(admin, shop, opts);
    assert.equal(computeCalls.length, 6);
    assert.equal(first.pendingFailedCount, 1);
    assert.deepEqual(first.pendingLocations, [{ locationId: gid(1001), locationName: "店01", days: 1 }]);
    assert.ok(warns.some((w) => w.includes("compute failed") && w.includes("location=1001") && w.includes("day=2026-11-02") && w.includes("Throttled")));
    const second = await buildPeriodSalesSummaryPayload(admin, shop, opts);
    assert.equal(computeCalls.length, 6, "2 回目は失敗した日を数え直さない");
    assert.equal(second.pendingFailedCount, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(enqueued.map((e) => e.items.map((i) => i.day)), [["2026-11-02"], ["2026-11-02"]]);
  } finally {
    console.warn = orig;
  }
});

test("画面が閉じられた（中断した）リクエストは、新しく数え始めない", async () => {
  reset(2);
  const ac = new AbortController();
  ac.abort();
  const p = await buildPeriodSalesSummaryPayload(admin, shop, {
    dateFrom: "2026-11-01",
    dateTo: "2026-11-03",
    signal: ac.signal,
    backgroundShopDomain: "x.myshopify.com",
  });
  assert.equal(computeCalls.length, 0);
  assert.equal(p.pendingComputeEstimate, 6);
});

test("「出す店」（visibleLocationIds）で店を絞るコードが残っていない", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) {
        const src = readFileSync(p, "utf8");
        if (/visibleLocationIds\.(includes|length)/.test(src)) offenders.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

const POS = { computeTimeBudgetMs: 60, backgroundShopDomain: "x.myshopify.com" };

test("今日の分だけで時間を超えても、保存がある今日の分は「数え終わっていない」にしない（裏で数え直す）", async () => {
  await settle();
  reset(6);
  cacheAll(locations, "2026-11-01", TODAY); // 今日の分も前の保存がある
  computeDelayMs = 25;
  const p = await buildPeriodSalesSummaryPayload(admin, shop, { dateFrom: "2026-11-01", dateTo: TODAY, ...POS });
  assert.ok(computeCalls.length < 6, `今日の分を数えたのは ${computeCalls.length} 店（時間で止まる）`);
  assert.equal(p.periodCachePartial, false);
  assert.equal(p.pendingLocations, undefined);
  assert.equal((p.totals as { orders: number }).orders, 6 * 24, "保存の数字で全店・全日が出る");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(enqueued[0]?.items.length, 6 - computeCalls.length, "数えなかった今日の分は裏で数え直す");
});

test("時間切れでも、ほかの読み込みが数えている途中の分は待って使う", async () => {
  reset(2);
  cacheAll(locations, "2026-11-01", "2026-11-22");
  // 11/23 の 2 店を、ほかの読み込みが数えている途中
  computeDelayMs = 40;
  const running = locations.map((l) =>
    shareInFlight(`loc|${SHOP_ID}|${l.shopifyLocationGid}|2026-11-23`, async () => {
      await new Promise((r) => setTimeout(r, 40));
      cacheRows.push({ shopId: SHOP_ID, locationId: l.shopifyLocationGid, targetDate: "2026-11-23", actual: 1000, orders: 1, items: 1, visitors: null, budget: null });
    }),
  );
  const p = await buildPeriodSalesSummaryPayload(admin, shop, {
    dateFrom: "2026-11-01",
    dateTo: "2026-11-23",
    computeTimeBudgetMs: 1,
    backgroundShopDomain: "x.myshopify.com",
  });
  await Promise.all(running);
  assert.equal(computeCalls.length, 0, "自分では数えない");
  assert.equal(p.pendingLocations, undefined, "待って使ったので欠けていない");
  assert.equal((p.totals as { orders: number }).orders, 2 * 23);
});

test("裏で数えるキューが使えないときは、今まで通り古い日から数え、時間で区切らない", async () => {
  reset(3);
  process.env.SALES_SUMMARY_FILL_QUEUE = "0";
  computeDelayMs = 5;
  const p = await buildPeriodSalesSummaryPayload(admin, shop, { dateFrom: "2026-11-01", dateTo: TODAY, ...POS });
  assert.equal(computeCalls[0], `${gid(1000)}|2026-11-01`, "古い日から");
  assert.equal(computeCalls.length, 48, "1 回のリクエストの上限（48）まで数える");
  assert.equal(p.periodCachePartial, true);
  assert.equal(enqueued.length, 0);
});

test("キューに積めなかったら、しばらくは古い日から数える形に戻す", async () => {
  reset(1);
  cacheAll(locations, "2026-11-01", "2026-11-20");
  enqueueResult = 0;
  computeDelayMs = 30;
  await buildPeriodSalesSummaryPayload(admin, shop, { dateFrom: "2026-11-01", dateTo: TODAY, ...POS });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(enqueued.length, 1);
  assert.equal(isSalesSummaryFillQueueUsable(), false);
});

test("販売チャネルの分が時間で数えきれないときも、保存が無ければ「数え終わっていない」に数える", async () => {
  reset(1);
  cacheAll(locations, "2026-11-01", TODAY);
  channels = [{ id: "ch1", displayName: "オンライン", sourceNames: ["web"] }];
  computeDelayMs = 30;
  const p = await buildPeriodSalesSummaryPayload(admin, shop, { dateFrom: "2026-11-20", dateTo: TODAY, ...POS });
  assert.ok(channelCalls.length < 5);
  assert.equal(p.periodCachePartial, true);
  assert.equal(p.pendingChannelCount, 5 - channelCalls.length);
});
