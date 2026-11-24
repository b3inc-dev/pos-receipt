import assert from "node:assert/strict";
import { mock, test } from "node:test";

const rows = new Map<string, string>();
const shownCalls: boolean[] = [];
const appSetting = {
  createMany: async ({ data }: any) => { if (!rows.has(data.key)) rows.set(data.key, data.valueJson); },
  findUnique: async ({ where }: any) => {
    const valueJson = rows.get(where.shopId_key.key);
    return valueJson === undefined ? null : { valueJson };
  },
  updateMany: async ({ where, data }: any) => {
    if (rows.get(where.key) !== where.valueJson) return { count: 0 };
    rows.set(where.key, data.valueJson);
    return { count: 1 };
  },
};
mock.module("../db.server", { defaultExport: {
  appSetting,
  budget: { findMany: async () => [] },
  ciaraFootfallDaily: { findMany: async () => [], upsert: async () => {} },
  $transaction: async (fn: any) => fn({ $queryRaw: async () => [{ valueJson: rows.get("ciara_visit_sync") }] }),
} });
mock.module("../utils/planFeatures.server", { namedExports: { isInhouseMode: () => true } });
mock.module("../utils/shopTimezone.server", { namedExports: {
  getShopTimezoneForDaily: async () => "Asia/Tokyo",
  getCalendarDateStringInTimeZone: () => "2026-11-24",
} });
mock.module("./ciaraSyncScheduler.server", { namedExports: { createCiaraSyncScheduler: () => ({}) } });
mock.module("./ciaraSystemOrigin.server", { namedExports: {
  CIARA_BUDGETS_PATH: "/budgets",
  CIARA_VISITS_PATH: "/visits",
  ciaraSystemUrl: (path: string) => new URL(path, "https://example.invalid"),
} });
mock.module("./budgetWrite.server", { namedExports: { applyBudgetDayChanges: async () => {} } });
mock.module("./footfallWrite.server", { namedExports: { refreshCachedVisitors: async (_db: unknown, _s: string, _l: string, _d: string, shown: boolean) => { shownCalls.push(shown); } } });

const budget = await import("./ciaraBudgetSync.server");
const visit = await import("./ciaraVisitSync.server");

for (const scenario of [
  { key: "ciara_budget_sync", run: budget.runCiaraBudgetSync, save: budget.saveCiaraBudgetSyncSettings },
  { key: "ciara_visit_sync", run: visit.runCiaraVisitSync, save: visit.saveCiaraVisitSyncSettings },
]) {
  for (const succeeds of [true, false]) {
    test(scenario.key + ": 実際の同期関数の途中でOFFを保存する (" + (succeeds ? "成功" : "取得失敗") + ")", async () => {
      shownCalls.length = 0;
      rows.set(scenario.key, JSON.stringify({ enabled: true, lastRun: null, syncedLocationIds: ["old"] }));
      const originalFetch = globalThis.fetch;
      const originalSecret = process.env.CIARA_BUDGET_SYNC_SECRET;
      process.env.CIARA_BUDGET_SYNC_SECRET = "synthetic-test-only";
      let fetched!: () => void;
      const started = new Promise<void>((resolve) => { fetched = resolve; });
      let release!: (response: Response) => void;
      globalThis.fetch = async () => { fetched(); return new Promise<Response>((resolve) => { release = resolve; }); };
      try {
        const running = scenario.run("shop", { graphql: async () => ({ json: async () => ({ data: { locations: { nodes: [{ id: "gid://shopify/Location/1" }] } } }) }) });
        await started;
        await scenario.save("shop", { enabled: false });
        release(succeeds
          ? Response.json({ ok: true, stores: scenario.key === "ciara_visit_sync" ? [{ shopifyLocationId: "1", storeName: "Synthetic", days: [{ date: "2026-11-24", visitCount: 20, reportedAt: null }] }] : [] })
          : new Response(null, { status: 503 }));
        const result = await running;
        assert.equal(result?.ok, succeeds);
        const saved = JSON.parse(rows.get(scenario.key)!);
        assert.equal(saved.enabled, false, "結果保存でOFFを巻き戻さない");
        assert.equal(saved.lastRun.ok, succeeds, "実際の終了処理は結果を保存する");
        if (scenario.key === "ciara_visit_sync" && succeeds) assert.deepEqual(shownCalls, [false], "遅い同期もOFF設定で表示キャッシュを更新する");
        if (!succeeds) assert.deepEqual(saved.syncedLocationIds, ["old"]);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalSecret === undefined) delete process.env.CIARA_BUDGET_SYNC_SECRET;
        else process.env.CIARA_BUDGET_SYNC_SECRET = originalSecret;
      }
    });
  }
}
