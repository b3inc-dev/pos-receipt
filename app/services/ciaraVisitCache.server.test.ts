import assert from "node:assert/strict";
import { mock, test } from "node:test";

// 設定行のロックを再現する合成DB。実DBの接続/外部APIは使わない。
let enabled = true;
let visitors = 0;
let tail = Promise.resolve();
let beforeCacheWrite: (() => Promise<void>) | null = null;
let failCacheWrite = false;
async function withRowLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tail;
  let unlock!: () => void;
  tail = new Promise<void>((resolve) => { unlock = resolve; });
  await previous;
  try { return await fn(); } finally { unlock(); }
}
mock.module("../db.server", { defaultExport: {
  $transaction: async (fn: any, options: any) => {
    assert.equal(options.timeout, 10_000);
    return withRowLock(() => fn({
      $queryRaw: async (sql: TemplateStringsArray) => {
        assert.match(sql.join("?"), /FOR UPDATE/);
        return [{ valueJson: JSON.stringify({ enabled }) }];
      },
    }));
  },
} });
mock.module("./footfallWrite.server", { namedExports: {
  refreshCachedVisitors: async (_tx: unknown, _s: string, _l: string, _d: string, shown: boolean) => {
    await beforeCacheWrite?.();
    if (failCacheWrite) throw new Error("synthetic DB failure");
    visitors = shown ? 20 : 7;
  },
} });
const { refreshCiaraVisitCache } = await import("./ciaraVisitCache.server");

test("OFF保存後に遅い同期がキャッシュを書いてもPOSの数を使う", async () => {
  enabled = false;
  visitors = 20;
  await refreshCiaraVisitCache("s", "L1", "2026-11-24");
  assert.equal(visitors, 7);
});

test("ONのキャッシュ更新中のOFF保存は、行ロック後に反映される", async () => {
  enabled = true;
  let arrived!: () => void;
  const writing = new Promise<void>((resolve) => { arrived = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  beforeCacheWrite = async () => { arrived(); await held; };
  try {
    const oldRefresh = refreshCiaraVisitCache("s", "L1", "2026-11-24");
    await writing;
    let saved = false;
    const saveOff = withRowLock(async () => { enabled = false; saved = true; });
    await Promise.resolve();
    assert.equal(saved, false, "設定保存は同じ行の更新が終わるまで待つ");
    release();
    await oldRefresh;
    await saveOff;
    beforeCacheWrite = null;
    // 管理画面での設定保存後も同じ関数で再描画する。
    await refreshCiaraVisitCache("s", "L1", "2026-11-24");
    assert.equal(enabled, false);
    assert.equal(visitors, 7);
  } finally { beforeCacheWrite = null; release(); }
});

test("キャッシュ更新失敗でもOFF設定は戻さず、ロックを解放して再実行できる", async () => {
  enabled = false;
  failCacheWrite = true;
  try {
    await assert.rejects(refreshCiaraVisitCache("s", "L1", "2026-11-24"), /synthetic DB failure/);
    assert.equal(enabled, false);
  } finally { failCacheWrite = false; }
  await refreshCiaraVisitCache("s", "L1", "2026-11-24");
  assert.equal(visitors, 7);
});
