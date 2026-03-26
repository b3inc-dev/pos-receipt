/**
 * 売上サマリー orders/updated 用キュー（pg-boss / PostgreSQL のみ・Redis 不要）
 *
 * - SALES_SUMMARY_WEBHOOK_QUEUE=0 または false で無効 → Webhook は従来どおり同期処理
 * - SALES_SUMMARY_WEBHOOK_DEBOUNCE_SECONDS=8 で同一ショップの連続 Webhook をまとめられる
 */
import prisma from "../db.server";
import PgBoss from "pg-boss";
import { executeSalesSummaryOrderWebhookJob } from "./salesSummaryWebhookRefresh.server";

export const SALES_SUMMARY_WEBHOOK_QUEUE_NAME = "pos-receipt-sales-summary-orders-updated";

type JobData = { shopDomain: string; payload: unknown };

let bossStartPromise: Promise<PgBoss | null> | null = null;

function queueDisabledByEnv(): boolean {
  return process.env.SALES_SUMMARY_WEBHOOK_QUEUE === "0" || process.env.SALES_SUMMARY_WEBHOOK_QUEUE === "false";
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

async function startBossAndWorker(): Promise<PgBoss | null> {
  if (queueDisabledByEnv() || !hasDatabaseUrl()) return null;

  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    application_name: "pos-receipt-pgboss",
  });

  boss.on("error", (err: Error) => {
    console.error("[pg-boss]", err);
  });

  await boss.start();

  await boss.createQueue(SALES_SUMMARY_WEBHOOK_QUEUE_NAME, {
    retryLimit: 5,
    retryDelay: 45,
    retryBackoff: true,
  }).catch(() => {
    /* キューが既にある */
  });

  await boss.work(
    SALES_SUMMARY_WEBHOOK_QUEUE_NAME,
    { teamSize: 2, pollingIntervalSeconds: 2 },
    async (jobs) => {
      const { unauthenticated } = await import("../shopify.server");
      for (const job of jobs) {
        const { shopDomain, payload } = job.data as JobData;
        try {
          const { admin } = await unauthenticated.admin(shopDomain);
          const dbShop = await prisma.shop.findFirst({ where: { shopDomain } });
          if (!dbShop) {
            console.warn(`[pg-boss] sales-summary: unknown shop ${shopDomain}`);
            continue;
          }
          const disabled = process.env.SALES_SUMMARY_WEBHOOK_REFRESH_DISABLED;
          if (disabled === "1" || disabled === "true") continue;

          const { targetDates, errors } = await executeSalesSummaryOrderWebhookJob(
            admin,
            dbShop.id,
            payload,
          );
          if (errors.length > 0) {
            console.warn(
              `[pg-boss] sales-summary partial shop=${shopDomain} dates=${targetDates.join(",")}`,
              errors.slice(0, 6),
            );
          } else {
            console.log(
              `[pg-boss] sales-summary ok shop=${shopDomain} dates=${targetDates.join(",")}`,
            );
          }
        } catch (e) {
          console.error(`[pg-boss] sales-summary job failed shop=${shopDomain}`, e);
          throw e;
        }
      }
    },
  );

  const stop = () => {
    void boss.stop({ timeout: 20000 }).catch(() => {});
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  return boss;
}

/**
 * ワーカー起動（1 プロセス 1 回）。DATABASE_URL が無い・キューOFFのときは null。
 */
export async function ensureSalesSummaryWebhookWorker(): Promise<PgBoss | null> {
  if (queueDisabledByEnv() || !hasDatabaseUrl()) return null;

  if (!bossStartPromise) {
    bossStartPromise = startBossAndWorker().catch((e) => {
      console.error("[pg-boss] start failed:", e);
      return null;
    });
  }
  return bossStartPromise;
}

/**
 * ジョブを積む。キューが使えなければ false（呼び出し側で同期フォールバック）。
 */
export async function enqueueSalesSummaryOrdersUpdatedJob(
  shopDomain: string,
  payload: unknown,
): Promise<boolean> {
  const boss = await ensureSalesSummaryWebhookWorker();
  if (!boss) return false;

  const data: JobData = { shopDomain, payload };
  const opts = { retryLimit: 5, retryBackoff: true };

  const debounceSec = Number(process.env.SALES_SUMMARY_WEBHOOK_DEBOUNCE_SECONDS);
  if (Number.isFinite(debounceSec) && debounceSec > 0) {
    await boss.sendDebounced(SALES_SUMMARY_WEBHOOK_QUEUE_NAME, data, opts, debounceSec, shopDomain);
  } else {
    await boss.send(SALES_SUMMARY_WEBHOOK_QUEUE_NAME, data, opts);
  }
  return true;
}
