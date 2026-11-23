/**
 * 処理待ちに置いた注文の通知（orders/updated の中身。お客様の情報が入ることがある）を、30 日で消す。
 * T さんの決定（11/23 1:50・連絡帳 #39）。
 *
 * - 置き場所は pg-boss の表（スキーマ pgboss の job と archive）。このアプリが積むのは
 *   SALES_SUMMARY_WEBHOOK_QUEUE_NAME のキューだけなので、そのキューの行だけを消す。
 * - スイッチ ORDER_WEBHOOK_QUEUE_PURGE（既定オフ）:
 *     off（または未設定）… 何もしない（タイマーも動かさない）
 *     preview          … 消す対象の件数を数えて記録に出すだけ
 *     one              … いちばん古い 1 件だけ消す
 *     all              … 対象をすべて消す
 *   T さんが preview → one → all の順に進める。
 * - 日数 ORDER_WEBHOOK_QUEUE_RETENTION_DAYS（既定 30。1〜30 にそろえる。30 日より長くはしない）
 * - 処理中（state = active）の行は消さない。
 * - 記録（ログ）には件数だけを出す。中身（payload）は読まない・出さない。
 * - pg-boss の表や列が思った形でないときは、何も消さずに「skip」と理由を出す。
 */
import { SALES_SUMMARY_WEBHOOK_QUEUE_NAME } from "./salesSummaryWebhookQueue.constants";

export type QueuePurgeMode = "off" | "preview" | "one" | "all";

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 30;
const PGBOSS_SCHEMA = "pgboss";
const TABLES = ["job", "archive"] as const;
type TableName = (typeof TABLES)[number];
const REQUIRED_COLUMNS = ["id", "name", "state", "created_on"];

type Env = Record<string, string | undefined>;

export function parseQueuePurgeMode(env: Env = process.env): QueuePurgeMode {
  const v = String(env.ORDER_WEBHOOK_QUEUE_PURGE ?? "").trim().toLowerCase();
  if (v === "preview" || v === "one" || v === "all") return v;
  return "off";
}

export function parseRetentionDays(env: Env = process.env): number {
  const raw = String(env.ORDER_WEBHOOK_QUEUE_RETENTION_DAYS ?? "").trim();
  const n = raw === "" ? DEFAULT_RETENTION_DAYS : Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RETENTION_DAYS;
  return Math.min(n, MAX_RETENTION_DAYS);
}

/** 生の SQL を投げる口（本番は prisma.$queryRawUnsafe。値はすべて $1… で渡す） */
export type SqlRunner = (text: string, ...params: unknown[]) => Promise<Array<Record<string, unknown>>>;

export type TableOutcome = {
  table: TableName;
  status: "ok" | "skip";
  reason?: "no_table" | "schema_mismatch";
  matched: number;
  deleted: number;
};

export type QueuePurgeResult = {
  mode: QueuePurgeMode;
  days: number;
  tables: TableOutcome[];
};

async function tableReady(sql: SqlRunner, table: TableName): Promise<TableOutcome["reason"] | null> {
  const rows = await sql(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    PGBOSS_SCHEMA,
    table,
  );
  if (rows.length === 0) return "no_table";
  const cols = new Set(rows.map((r) => String(r.column_name)));
  return REQUIRED_COLUMNS.every((c) => cols.has(c)) ? null : "schema_mismatch";
}

// 表の名前は上の TABLES の決まった値だけ（外から来た文字は入らない）。
const whereOld = `name = $1 AND state::text <> 'active' AND created_on < now() - make_interval(days => $2::int)`;

export async function purgeOrderWebhookQueue({
  sql,
  env = process.env,
  log = console.info,
}: {
  sql: SqlRunner;
  env?: Env;
  log?: (...args: unknown[]) => void;
}): Promise<QueuePurgeResult> {
  const mode = parseQueuePurgeMode(env);
  const days = parseRetentionDays(env);
  const result: QueuePurgeResult = { mode, days, tables: [] };
  if (mode === "off") return result;

  let oneLeft = mode === "one" ? 1 : 0;
  for (const table of TABLES) {
    const reason = await tableReady(sql, table);
    if (reason) {
      result.tables.push({ table, status: "skip", reason, matched: 0, deleted: 0 });
      continue;
    }
    const fq = `"${PGBOSS_SCHEMA}"."${table}"`;
    const countRows = await sql(
      `SELECT count(*)::int AS n FROM ${fq} WHERE ${whereOld}`,
      SALES_SUMMARY_WEBHOOK_QUEUE_NAME,
      days,
    );
    const matched = Number(countRows[0]?.n ?? 0);
    let deleted = 0;
    if (matched > 0 && mode === "all") {
      const rows = await sql(
        `WITH d AS (DELETE FROM ${fq} WHERE ${whereOld} RETURNING 1) SELECT count(*)::int AS n FROM d`,
        SALES_SUMMARY_WEBHOOK_QUEUE_NAME,
        days,
      );
      deleted = Number(rows[0]?.n ?? 0);
    } else if (matched > 0 && oneLeft > 0) {
      const rows = await sql(
        `WITH d AS (DELETE FROM ${fq} WHERE name = $1 AND id = (SELECT id FROM ${fq} WHERE ${whereOld} ORDER BY created_on ASC LIMIT 1) RETURNING 1) SELECT count(*)::int AS n FROM d`,
        SALES_SUMMARY_WEBHOOK_QUEUE_NAME,
        days,
      );
      deleted = Number(rows[0]?.n ?? 0);
      oneLeft -= deleted;
    }
    result.tables.push({ table, status: "ok", matched, deleted });
  }

  log(
    `[queue-retention] mode=${mode} days=${days} ` +
      result.tables
        .map((t) => (t.status === "skip" ? `${t.table}=skip(${t.reason})` : `${t.table}: matched=${t.matched} deleted=${t.deleted}`))
        .join(" "),
  );
  return result;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
let timerStarted = false;

/**
 * ワーカーを動かしているプロセスで 1 回だけ呼ぶ。スイッチがオフならタイマーを作らない。
 * 起動の 1 分後に 1 回、その後は 24 時間ごと。失敗しても次の回にまた試す（アプリは止めない）。
 */
export function startOrderWebhookQueueRetentionTimer({
  sql,
  env = process.env,
}: {
  sql: SqlRunner;
  env?: Env;
}): boolean {
  if (timerStarted) return false;
  if (parseQueuePurgeMode(env) === "off") return false;
  timerStarted = true;
  const run = () => {
    void purgeOrderWebhookQueue({ sql, env }).catch((e) => {
      console.error("[queue-retention] failed", e instanceof Error ? e.message : String(e));
    });
  };
  setTimeout(run, FIRST_RUN_DELAY_MS).unref?.();
  setInterval(run, DAY_MS).unref?.();
  return true;
}
