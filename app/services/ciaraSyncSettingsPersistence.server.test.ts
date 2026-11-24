import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patchSyncSettings, type SyncSettingsStore } from "./ciaraSyncSettingsPersistence.server";

function memoryStore(initial: Record<string, unknown> | null) {
  let value = initial === null ? null : JSON.stringify(initial);
  let beforeUpdate: (() => void) | null = null;
  let updates = 0;
  const store: SyncSettingsStore = {
    createMany: async ({ data }) => { if (value === null) value = data.valueJson; },
    findUnique: async () => value === null ? null : { valueJson: value },
    updateMany: async ({ where, data }) => {
      updates++;
      beforeUpdate?.();
      beforeUpdate = null;
      if (value !== where.valueJson) return { count: 0 };
      value = data.valueJson;
      return { count: 1 };
    },
  };
  return {
    store,
    read: () => JSON.parse(value!),
    change: (patch: Record<string, unknown>) => { value = JSON.stringify({ ...JSON.parse(value!), ...patch }); },
    race: (fn: () => void) => { beforeUpdate = fn; },
    updates: () => updates,
  };
}

describe("同期設定と結果の並行保存", () => {
  for (const key of ["ciara_budget_sync", "ciara_visit_sync"]) {
    const defaults = { enabled: false, lastRun: null as null | { ok: boolean }, syncedLocationIds: [] as string[] };

    it(key + ": 同期中にOFFを保存しても成功結果はONへ戻さない", async () => {
      const s = memoryStore({ ...defaults, enabled: true, custom: "keep" });
      // worker が読んだ直後に、別リクエストが OFF を保存した順序。
      s.race(() => s.change({ enabled: false }));
      await patchSyncSettings(s.store, "shop", key, defaults, { lastRun: { ok: true }, syncedLocationIds: ["L1"] });
      assert.equal(s.read().enabled, false);
      assert.deepEqual(s.read().lastRun, { ok: true });
      assert.deepEqual(s.read().syncedLocationIds, ["L1"]);
      assert.equal(s.read().custom, "keep");
      assert.equal(s.updates(), 2, "競合したら最新の値に適用し直す");
    });

    it(key + ": OFF保存の直前に同期が終わっても結果を巻き戻さない", async () => {
      const s = memoryStore({ ...defaults, enabled: true });
      s.race(() => s.change({ lastRun: { ok: true }, syncedLocationIds: ["L1"] }));
      await patchSyncSettings(s.store, "shop", key, defaults, { enabled: false });
      assert.equal(s.read().enabled, false);
      assert.deepEqual(s.read().lastRun, { ok: true });
      assert.deepEqual(s.read().syncedLocationIds, ["L1"]);
    });

    it(key + ": 初回の結果保存も既定OFFを保持する", async () => {
      const s = memoryStore(null);
      await patchSyncSettings(s.store, "shop", key, defaults, { lastRun: { ok: false } });
      assert.equal(s.read().enabled, false);
      assert.deepEqual(s.read().lastRun, { ok: false });
    });
  }

  it("競合が続くと古い値で強制保存せず失敗を返す", async () => {
    let attempts = 0;
    const store: SyncSettingsStore = {
      createMany: async () => {},
      findUnique: async () => ({ valueJson: '{"enabled":false}' }),
      updateMany: async () => { attempts++; return { count: 0 }; },
    };
    await assert.rejects(patchSyncSettings(store, "s", "k", { enabled: false }, { enabled: true }), /retry the operation/);
    assert.equal(attempts, 5);
  });
});
