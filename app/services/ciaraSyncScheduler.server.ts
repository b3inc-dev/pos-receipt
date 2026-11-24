/**
 * ciara-system とのつながり（予算・入店数）の定期の仕事を始める共通処理。
 *
 * 前は列（pg-boss の queue）を作る失敗を捨てていたので、列が無いまま schedule して
 * 「Queue … not found」で止まり、そのサーバーが動いている間は二度と始まらなかった（11/24 本番）。
 * - 列を作る失敗は記録に出し、間をおいて数回やり直す。作れたかは列を読み直して確かめる
 * - それでも始まらなければ、使った pg-boss を止め、少し待ってから自動でもう一度始める
 * - 今の状態（始めている・動いている・始まっていない）を管理画面に出せるように持つ
 */
import PgBoss from "pg-boss";

export type CiaraSchedulerState = "off" | "starting" | "running" | "failed";

export type CiaraSchedulerStatus = {
  state: CiaraSchedulerState;
  /** 始まらなかったときの記録用の文（画面には出さない） */
  error?: string;
  /** 状態が変わった時刻 */
  at?: string;
};

/** テストで差し替える部分（pg-boss のうち使うものだけ） */
export type SchedulerBoss = {
  on(event: "error", listener: (err: Error) => void): unknown;
  start(): Promise<unknown>;
  stop(options?: { timeout?: number }): Promise<unknown>;
  createQueue(name: string, options: Record<string, unknown>): Promise<unknown>;
  getQueue(name: string): Promise<unknown>;
  schedule(name: string, cron: string, data: object, options: { tz: string }): Promise<unknown>;
  work(name: string, handler: () => Promise<void>): Promise<unknown>;
};

export type CiaraSchedulerOptions = {
  /** 記録の頭（例: ciara-budget-sync） */
  tag: string;
  queue: string;
  cron: string;
  /** 動かす条件（自社用・鍵・読む先・DB）。false なら始めない */
  ready: () => boolean;
  work: () => Promise<void>;
  createBoss?: () => SchedulerBoss;
  /** 列を作るやり直しの回数と間（ミリ秒） */
  queueAttempts?: number;
  queueRetryDelayMs?: number;
  /** 始まらなかったあと、もう一度始めるまでの間（ミリ秒）。0 なら自動ではやり直さない */
  restartDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 列を作る。失敗は記録に出し、間をおいてやり直す。最後に列があるかを読み直して確かめる */
export async function createQueueWithRetry(
  boss: Pick<SchedulerBoss, "createQueue" | "getQueue">,
  queue: string,
  options: Record<string, unknown>,
  { tag, attempts = 3, delayMs = 3000, sleep = defaultSleep }: { tag: string; attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  let lastError: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      await boss.createQueue(queue, options);
    } catch (e) {
      lastError = e;
      console.warn(`[${tag}] create queue failed (try ${i}/${attempts}):`, e);
    }
    try {
      if (await boss.getQueue(queue)) return;
    } catch (e) {
      lastError = e;
      console.warn(`[${tag}] read queue failed (try ${i}/${attempts}):`, e);
    }
    if (i < attempts) await sleep(delayMs * i);
  }
  const reason = lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "the queue is still missing";
  throw new Error(`queue ${queue} could not be created: ${reason}`);
}

export function createCiaraSyncScheduler(opts: CiaraSchedulerOptions) {
  const {
    tag,
    queue,
    cron,
    ready,
    work,
    createBoss = () =>
      new PgBoss({ connectionString: process.env.DATABASE_URL, application_name: `pos-receipt-${tag}` }) as unknown as SchedulerBoss,
    queueAttempts = 3,
    queueRetryDelayMs = 3000,
    restartDelayMs = 5 * 60_000,
    sleep = defaultSleep,
    now = () => new Date(),
  } = opts;

  let startPromise: Promise<SchedulerBoss | null> | null = null;
  let status: CiaraSchedulerStatus = { state: "off" };
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let signalsHooked = false;
  let current: SchedulerBoss | null = null;

  const setStatus = (state: CiaraSchedulerState, error?: string) => {
    status = { state, error, at: now().toISOString() };
  };

  const ensure = (): Promise<SchedulerBoss | null> => {
    if (!ready()) return Promise.resolve(null);
    if (startPromise) return startPromise;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    setStatus("starting");
    startPromise = (async () => {
      const boss = createBoss();
      boss.on("error", (err: Error) => console.error(`[${tag}]`, err));
      try {
        await boss.start();
        await createQueueWithRetry(boss, queue, { name: queue, retryLimit: 0 }, {
          tag,
          attempts: queueAttempts,
          delayMs: queueRetryDelayMs,
          sleep,
        });
        // pg-boss の schedule は複数のサーバーでも 1 回だけ動く
        await boss.schedule(queue, cron, {}, { tz: "Asia/Tokyo" });
        await boss.work(queue, work);
      } catch (e) {
        await boss.stop({ timeout: 5000 }).catch(() => {});
        throw e;
      }
      current = boss;
      if (!signalsHooked) {
        signalsHooked = true;
        const stop = () => void current?.stop({ timeout: 20000 }).catch(() => {});
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
      }
      setStatus("running");
      console.log(`[${tag}] scheduler started (${cron} Asia/Tokyo)`);
      return boss;
    })().catch((e) => {
      console.error(`[${tag}] start failed:`, e);
      setStatus("failed", e instanceof Error ? e.message : String(e));
      // 次の機会（画面を開いたとき・下のやり直し）にもう一度始められるようにする
      startPromise = null;
      if (restartDelayMs > 0) {
        restartTimer = setTimeout(() => {
          restartTimer = null;
          void ensure();
        }, restartDelayMs);
        restartTimer.unref?.();
      }
      return null;
    });
    return startPromise;
  };

  return {
    ensure,
    /** 今の状態（動かす条件が無いときは off） */
    status(): CiaraSchedulerStatus {
      if (!ready()) return { state: "off" };
      return status;
    },
  };
}
