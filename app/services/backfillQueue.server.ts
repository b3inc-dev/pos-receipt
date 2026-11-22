/**
 * 過去データ取り込み（/app/backfill）を、画面を閉じても裏で 1 日ずつ進めるキュー（pg-boss / PostgreSQL）。
 * T さんの決定（2026-11-22）: 画面を閉じても裏で進むようにする。UI ルール v1.1 の 12章。
 *
 * - 進み具合は AppSetting の 1 行（BACKFILL_RUN_KEY）に JSON で持つ。新しい表は作らない
 * - 1 つのジョブが 1 日を取り込み、次の日のジョブを積む（1 店 1 本だけ動く）
 * - 止めるときは BACKFILL_STOP_KEY に runId を書く。次のジョブがそれを見て止まる
 * - 取り込み済みの日は飛ばす（今までの画面と同じ skipExisting）
 * - BACKFILL_QUEUE=0 または false、または DATABASE_URL が無いときは使わない（画面が今までどおり 1 日ずつ送る）
 */
import PgBoss from "pg-boss";
import prisma from "../db.server";
import { getAppSetting, setAppSetting } from "../utils/appSettings.server";
import { computeAndCacheDailySummary } from "./salesSummaryEngine.server";
import { asRun, finishedIfNoneLeft, nextDay, withDayResult, type BackfillRun } from "../utils/backfillRun";

export const BACKFILL_QUEUE_NAME = "pos-receipt-backfill";
export const BACKFILL_RUN_KEY = "backfill_run";
export const BACKFILL_STOP_KEY = "backfill_run_stop";
/** 1 日ごとの間（Shopify の API を続けて叩きすぎない） */
const NEXT_DAY_DELAY_SECONDS = 1;

type JobData = { shopDomain: string; shopId: string; runId: string };

let bossStartPromise: Promise<PgBoss | null> | null = null;

function queueDisabled(): boolean {
  const v = process.env.BACKFILL_QUEUE;
  return v === "0" || v === "false" || !process.env.DATABASE_URL?.trim();
}

export async function readBackfillRun(shopId: string): Promise<BackfillRun | null> {
  return asRun(await getAppSetting(shopId, BACKFILL_RUN_KEY));
}

export async function writeBackfillRun(shopId: string, run: BackfillRun): Promise<void> {
  await setAppSetting(shopId, BACKFILL_RUN_KEY, run);
}

export async function isStopRequested(shopId: string, runId: string): Promise<boolean> {
  const stop = await getAppSetting<{ runId?: string | null }>(shopId, BACKFILL_STOP_KEY);
  return stop?.runId === runId;
}

export async function setStopRequest(shopId: string, runId: string | null): Promise<void> {
  await setAppSetting(shopId, BACKFILL_STOP_KEY, { runId });
}

/** 1 日分を進める。続きがあれば true（次のジョブを積む）。 */
export type BackfillStore = {
  readRun: (shopId: string) => Promise<BackfillRun | null>;
  writeRun: (shopId: string, run: BackfillRun) => Promise<void>;
  stopRequested: (shopId: string, runId: string) => Promise<boolean>;
};

const appSettingStore: BackfillStore = {
  readRun: readBackfillRun,
  writeRun: writeBackfillRun,
  stopRequested: isStopRequested,
};

export async function processBackfillStep(
  data: JobData,
  deps: {
    getAdmin: (shopDomain: string) => Promise<Parameters<typeof computeAndCacheDailySummary>[0]>;
    hasCache: (shopId: string, locationId: string, targetDate: string) => Promise<boolean>;
    compute: (...args: Parameters<typeof computeAndCacheDailySummary>) => Promise<unknown>;
    now: () => string;
    store?: BackfillStore;
  },
): Promise<boolean> {
  const { shopId, runId } = data;
  const { readRun: readBackfillRun, writeRun: writeBackfillRun, stopRequested: isStopRequested } = deps.store ?? appSettingStore;
  const run = await readBackfillRun(shopId);
  if (!run || run.runId !== runId || run.state !== "running") return false;

  if (await isStopRequested(shopId, runId)) {
    await writeBackfillRun(shopId, { ...run, state: "stopped", updatedAt: deps.now() });
    return false;
  }

  const day = nextDay(run);
  if (!day) {
    await writeBackfillRun(shopId, finishedIfNoneLeft(run, deps.now()));
    return false;
  }

  await writeBackfillRun(shopId, withDayResult(run, day.targetDate, "processing", undefined, deps.now()));

  let status: "done" | "skipped" | "error";
  let reason: string | undefined;
  const cached = await deps.hasCache(shopId, run.locationId, day.targetDate);
  // Shopify に入れない（トークン切れなど）ときはここで投げ、pg-boss にやり直させる（その日は processing のまま残り、次も同じ日から）
  const admin = cached ? null : await deps.getAdmin(data.shopDomain);
  try {
    if (cached || !admin) {
      status = "skipped";
      reason = "already_cached";
    } else {
      await deps.compute(admin, shopId, run.locationId, run.locationName, day.targetDate);
      status = "done";
    }
  } catch (e) {
    status = "error";
    reason = e instanceof Error ? e.message : "Unknown error";
  }

  // 止めた・始め直したかもしれないので読み直し、その日の結果だけを入れる
  const latest = await readBackfillRun(shopId);
  if (!latest || latest.runId !== runId) return false;
  const updated = finishedIfNoneLeft(withDayResult(latest, day.targetDate, status, reason, deps.now()), deps.now());
  await writeBackfillRun(shopId, updated);
  return updated.state === "running" && !(await isStopRequested(shopId, runId));
}

async function startBoss(): Promise<PgBoss | null> {
  if (queueDisabled()) return null;
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    application_name: "pos-receipt-backfill",
    max: 2,
  });
  boss.on("error", (err: Error) => console.error("[pg-boss backfill]", err));
  await boss.start();
  await boss.createQueue(BACKFILL_QUEUE_NAME, { name: BACKFILL_QUEUE_NAME, retryLimit: 3, retryDelay: 30, retryBackoff: true }).catch(() => {
    /* キューが既にある */
  });

  await boss.work(BACKFILL_QUEUE_NAME, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as JobData;
      const more = await processBackfillStep(data, {
        // Shopify に入るのは集計が要る日だけ（取込済みの日は入らない）
        getAdmin: async (shopDomain) => {
          const { unauthenticated } = await import("../shopify.server");
          return (await unauthenticated.admin(shopDomain)).admin;
        },
        hasCache: async (shopId, locationId, targetDate) =>
          Boolean(await prisma.salesSummaryCacheDaily.findFirst({ where: { shopId, locationId, targetDate }, select: { id: true } })),
        compute: computeAndCacheDailySummary,
        now: () => new Date().toISOString(),
      });
      if (more) await boss.send(BACKFILL_QUEUE_NAME, data, { startAfter: NEXT_DAY_DELAY_SECONDS, retryLimit: 3, retryBackoff: true });
    }
  });

  const stop = () => {
    void boss.stop({ timeout: 20000 }).catch(() => {});
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return boss;
}

/** キューを起こす（1 プロセス 1 回）。使えないときは null。 */
export async function ensureBackfillWorker(): Promise<PgBoss | null> {
  if (queueDisabled()) return null;
  if (!bossStartPromise) {
    bossStartPromise = startBoss().catch((e) => {
      console.error("[pg-boss backfill] start failed:", e);
      bossStartPromise = null;
      return null;
    });
  }
  return bossStartPromise;
}

/** 次の 1 日のジョブを積む。キューが使えなければ false。 */
export async function enqueueBackfillStep(data: JobData): Promise<boolean> {
  const boss = await ensureBackfillWorker();
  if (!boss) return false;
  await boss.send(BACKFILL_QUEUE_NAME, data, { retryLimit: 3, retryBackoff: true });
  return true;
}

// サーバーが立ち上がったら、すぐワーカーを起こす（再起動の前に積んだジョブを続ける）
if (typeof queueMicrotask !== "undefined" && typeof window === "undefined" && !process.env.NODE_TEST_CONTEXT) {
  queueMicrotask(() => {
    void ensureBackfillWorker();
  });
}
