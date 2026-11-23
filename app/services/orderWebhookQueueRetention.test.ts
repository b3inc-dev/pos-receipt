import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseQueuePurgeMode,
  parseRetentionDays,
  purgeOrderWebhookQueue,
  startOrderWebhookQueueRetentionTimer,
  type SqlRunner,
} from "./orderWebhookQueueRetention.server";
import { SALES_SUMMARY_WEBHOOK_QUEUE_NAME } from "./salesSummaryWebhookQueue.constants";

const COLS = ["id", "name", "state", "created_on", "data"].map((c) => ({ column_name: c }));

/** 表ごとの「古い行の数」を持つ偽の DB。投げられた SQL を覚える。 */
function fakeSql(old: Record<string, number>, opts: { missing?: string[]; noCreatedOn?: string[] } = {}) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const left = { ...old };
  const run: SqlRunner = async (text, ...params) => {
    calls.push({ text, params });
    if (text.includes("information_schema.columns")) {
      const table = String(params[1]);
      if (opts.missing?.includes(table)) return [];
      if (opts.noCreatedOn?.includes(table)) return COLS.filter((c) => c.column_name !== "created_on");
      return COLS;
    }
    const table = text.includes('"pgboss"."archive"') ? "archive" : "job";
    if (text.startsWith("SELECT count(*)")) return [{ n: left[table] ?? 0 }];
    if (text.includes("DELETE") && text.includes("LIMIT 1")) {
      const n = Math.min(1, left[table] ?? 0);
      left[table] = (left[table] ?? 0) - n;
      return [{ n }];
    }
    if (text.includes("DELETE")) {
      const n = left[table] ?? 0;
      left[table] = 0;
      return [{ n }];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return { run, calls, left };
}

const quiet = () => {};

describe("parseQueuePurgeMode / parseRetentionDays", () => {
  it("既定はオフ・30 日", () => {
    assert.equal(parseQueuePurgeMode({}), "off");
    assert.equal(parseQueuePurgeMode({ ORDER_WEBHOOK_QUEUE_PURGE: "yes" }), "off");
    assert.equal(parseQueuePurgeMode({ ORDER_WEBHOOK_QUEUE_PURGE: " Preview " }), "preview");
    assert.equal(parseQueuePurgeMode({ ORDER_WEBHOOK_QUEUE_PURGE: "one" }), "one");
    assert.equal(parseQueuePurgeMode({ ORDER_WEBHOOK_QUEUE_PURGE: "all" }), "all");
    assert.equal(parseRetentionDays({}), 30);
  });

  it("日数は 1〜30 にそろえる（30 日より長くしない）", () => {
    assert.equal(parseRetentionDays({ ORDER_WEBHOOK_QUEUE_RETENTION_DAYS: "7" }), 7);
    assert.equal(parseRetentionDays({ ORDER_WEBHOOK_QUEUE_RETENTION_DAYS: "90" }), 30);
    assert.equal(parseRetentionDays({ ORDER_WEBHOOK_QUEUE_RETENTION_DAYS: "0" }), 30);
    assert.equal(parseRetentionDays({ ORDER_WEBHOOK_QUEUE_RETENTION_DAYS: "abc" }), 30);
  });
});

describe("purgeOrderWebhookQueue", () => {
  it("オフなら SQL を 1 本も投げない", async () => {
    const db = fakeSql({ job: 3, archive: 5 });
    const res = await purgeOrderWebhookQueue({ sql: db.run, env: {}, log: quiet });
    assert.equal(res.mode, "off");
    assert.deepEqual(db.calls, []);
  });

  it("preview は数えるだけで消さない", async () => {
    const db = fakeSql({ job: 3, archive: 5 });
    const res = await purgeOrderWebhookQueue({ sql: db.run, env: { ORDER_WEBHOOK_QUEUE_PURGE: "preview" }, log: quiet });
    assert.deepEqual(
      res.tables.map((t) => [t.table, t.matched, t.deleted]),
      [["job", 3, 0], ["archive", 5, 0]],
    );
    assert.ok(db.calls.every((c) => !c.text.includes("DELETE")));
    assert.deepEqual(db.left, { job: 3, archive: 5 });
  });

  it("one はぜんぶの表で合わせて 1 件だけ消す", async () => {
    const db = fakeSql({ job: 3, archive: 5 });
    const res = await purgeOrderWebhookQueue({ sql: db.run, env: { ORDER_WEBHOOK_QUEUE_PURGE: "one" }, log: quiet });
    assert.equal(res.tables.reduce((s, t) => s + t.deleted, 0), 1);
    assert.deepEqual(db.left, { job: 2, archive: 5 });
  });

  it("all は対象をすべて消す。キューの名前と日数は値として渡し、処理中は除く", async () => {
    const db = fakeSql({ job: 3, archive: 5 });
    const res = await purgeOrderWebhookQueue({
      sql: db.run,
      env: { ORDER_WEBHOOK_QUEUE_PURGE: "all", ORDER_WEBHOOK_QUEUE_RETENTION_DAYS: "45" },
      log: quiet,
    });
    assert.equal(res.days, 30);
    assert.deepEqual(db.left, { job: 0, archive: 0 });
    const deletes = db.calls.filter((c) => c.text.includes("DELETE"));
    assert.equal(deletes.length, 2);
    for (const d of deletes) {
      assert.deepEqual(d.params, [SALES_SUMMARY_WEBHOOK_QUEUE_NAME, 30]);
      assert.match(d.text, /state::text <> 'active'/);
      assert.match(d.text, /created_on < now\(\) - make_interval\(days => \$2::int\)/);
    }
  });

  it("表が無い・列が足りないときは何も消さずに skip", async () => {
    const db = fakeSql({ job: 3, archive: 5 }, { missing: ["archive"], noCreatedOn: ["job"] });
    const res = await purgeOrderWebhookQueue({ sql: db.run, env: { ORDER_WEBHOOK_QUEUE_PURGE: "all" }, log: quiet });
    assert.deepEqual(
      res.tables.map((t) => [t.table, t.status, t.reason]),
      [["job", "skip", "schema_mismatch"], ["archive", "skip", "no_table"]],
    );
    assert.ok(db.calls.every((c) => !c.text.includes("DELETE")));
  });

  it("記録には件数だけを出す（中身は読まない）", async () => {
    const db = fakeSql({ job: 1, archive: 2 });
    const lines: string[] = [];
    await purgeOrderWebhookQueue({
      sql: db.run,
      env: { ORDER_WEBHOOK_QUEUE_PURGE: "all" },
      log: (...a) => lines.push(a.join(" ")),
    });
    assert.deepEqual(lines, [
      "[queue-retention] mode=all days=30 job: matched=1 deleted=1 archive: matched=2 deleted=2",
    ]);
    assert.ok(db.calls.every((c) => !/\bdata\b/.test(c.text.replace("information_schema", ""))));
  });
});

describe("startOrderWebhookQueueRetentionTimer", () => {
  it("オフならタイマーを作らない", () => {
    const db = fakeSql({});
    assert.equal(startOrderWebhookQueueRetentionTimer({ sql: db.run, env: {} }), false);
  });
});
