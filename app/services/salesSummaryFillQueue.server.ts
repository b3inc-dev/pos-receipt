import { runAsSettlementBackground } from "../lib/shopifyGraphqlThrottle.server";
/**
 * 売上サマリー: 保存（SalesSummaryCacheDaily）の無い「店×日」を裏で数えて保存するキュー（pg-boss / PostgreSQL）。
 *
 * なぜ: POS の全店の当月（期間）は、保存の無い「店×日」をリクエストの中で 1 つずつ数えていた。
 * 店を足した直後（Ciara 2026-11-24: 3 店 × 23 日）は数分かかり、POS の待ち時間を超えて切れていた。
 * いまは POS の期間の読み込みが決まった時間を超えた分をここへ積み、画面は保存済みの分だけで先に返す。
 * 店舗設定で売上サマリーをオンにした店も、当月分をここへ積む。
 *
 * - 1 ジョブ = 1 店 × 1 日。同じ「店×日」は 1 つしか積まない（policy short + singletonKey）
 * - 数え方は画面と同じ computeAndCacheDailySummary（お金の数え方は変えない）
 * - 過去の日で保存がもうあれば何もしない（今日の分は保存があっても数え直す）
 * - SALES_SUMMARY_FILL_QUEUE=0 または false、または DATABASE_URL が無いときは使わない（今までどおりリクエストの中で数える）
 */
import PgBoss from "pg-boss";
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "./salesSummaryEngine.server";
import { shareInFlight } from "../utils/salesSummaryLoadShare.server";
import {
  clearSalesSummaryComputeFailed,
  computeFailureReason,
  markSalesSummaryComputeFailed,
} from "../utils/salesSummaryPeriodCache.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";

export const SALES_SUMMARY_FILL_QUEUE_NAME = "pos-receipt-sales-summary-fill";

export type SalesSummaryFillItem = {
  locationGid: string;
  locationName: string;
  day: string;
};

export type SalesSummaryFillJobData = SalesSummaryFillItem & {
  shopDomain: string;
  shopId: string;
};

/** 1 つ終わるごとの間（Shopify の API と精算の順番待ちを、POS の画面より先に埋めない） */
const NEXT_JOB_DELAY_SECONDS = 1;

let bossStartPromise: Promise<PgBoss | null> | null = null;

function queueDisabled(): boolean {
  const v = process.env.SALES_SUMMARY_FILL_QUEUE;
  return v === "0" || v === "false" || !process.env.DATABASE_URL?.trim();
}

export function salesSummaryComputeKey(shopId: string, locationGid: string, day: string): string {
  return `loc|${shopId}|${locationGid}|${day}`;
}

export function fillSingletonKey(shopId: string, locationGid: string, day: string): string {
  return `${shopId}|${locationGid}|${day}`;
}

export type FillJobDeps = {
  getAdmin: (shopDomain: string) => Promise<Parameters<typeof computeAndCacheDailySummary>[0]>;
  hasCache: (shopId: string, locationGid: string, day: string) => Promise<boolean>;
  compute: (...args: Parameters<typeof computeAndCacheDailySummary>) => Promise<unknown>;
  today: (admin: Parameters<typeof computeAndCacheDailySummary>[0], shopId: string) => Promise<string | null>;
};

/**
 * 1 つの「店×日」を数える。結果: done（数えた）・skipped（もう保存がある）。
 * 数えるのに失敗したら投げる（pg-boss がやり直す）。
 */
export async function processSalesSummaryFillJob(
  data: SalesSummaryFillJobData,
  deps: FillJobDeps,
): Promise<"done" | "skipped"> {
  const { shopId, locationGid, locationName, day } = data;
  // 過去の日で保存がもうあれば、Shopify に入らずに終える（今日より前かは保存の日付で見る）
  const hasCache = await deps.hasCache(shopId, locationGid, day);
  const admin = await deps.getAdmin(data.shopDomain);
  const today = await deps.today(admin, shopId);
  const isPast = today ? day < today : true;
  if (isPast && hasCache) return "skipped";
  const key = salesSummaryComputeKey(shopId, locationGid, day);
  try {
    await shareInFlight(key, () => runAsSettlementBackground(() => deps.compute(admin, shopId, locationGid, locationName, day)));
    clearSalesSummaryComputeFailed(key);
    return "done";
  } catch (e) {
    markSalesSummaryComputeFailed(key);
    console.warn(
      `[sales-summary fill] failed shop=${shopId} location=${locationGid.replace("gid://shopify/Location/", "")} day=${day} reason=${computeFailureReason(e)}`,
    );
    throw e;
  }
}

async function hasCacheInDb(shopId: string, locationGid: string, day: string): Promise<boolean> {
  const raw = locationGid.replace("gid://shopify/Location/", "");
  const row = await prisma.salesSummaryCacheDaily.findFirst({
    where: { shopId, locationId: { in: [locationGid, raw] }, targetDate: day },
    select: { id: true },
  });
  return Boolean(row);
}

async function startBoss(): Promise<PgBoss | null> {
  if (queueDisabled()) return null;
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    application_name: "pos-receipt-sales-summary-fill",
    max: 2,
  });
  boss.on("error", (err: Error) => console.error("[pg-boss sales-summary fill]", err));
  await boss.start();
  await boss
    .createQueue(SALES_SUMMARY_FILL_QUEUE_NAME, {
      name: SALES_SUMMARY_FILL_QUEUE_NAME,
      // 積んで待っている同じ「店×日」は 1 つだけ
      policy: "short",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
    })
    .catch(() => {
      /* キューが既にある */
    });

  await boss.work(SALES_SUMMARY_FILL_QUEUE_NAME, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as SalesSummaryFillJobData;
      await processSalesSummaryFillJob(data, {
        getAdmin: async (shopDomain) => {
          const { unauthenticated } = await import("../shopify.server");
          return (await unauthenticated.admin(shopDomain)).admin;
        },
        hasCache: hasCacheInDb,
        compute: computeAndCacheDailySummary,
        today: async (admin, shopId) =>
          getCalendarDateStringInTimeZone(new Date(), await getShopTimezoneForDaily(admin, shopId)),
      });
      await new Promise((r) => setTimeout(r, NEXT_JOB_DELAY_SECONDS * 1000));
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
export async function ensureSalesSummaryFillWorker(): Promise<PgBoss | null> {
  if (queueDisabled()) return null;
  if (!bossStartPromise) {
    bossStartPromise = startBoss().catch((e) => {
      console.error("[pg-boss sales-summary fill] start failed:", e);
      bossStartPromise = null;
      return null;
    });
  }
  return bossStartPromise;
}

export type EnqueueFillResult = {
  /** キューが使えたか（false = キューが起きない・送るときに失敗した） */
  usable: boolean;
  /** 新しく積めた数 */
  queued: number;
  /** 同じ「店×日」がもう待っていたので積まなかった数（使えないのとは違う） */
  alreadyQueued: number;
};

/**
 * 「店×日」を裏で数えるよう積む。同じ「店×日」が待っていれば積まない。
 * today を渡すと、今日の分を先に数える（priority）。店をオンにした直後の過去の日の後ろに並ばないため。
 */
export async function enqueueSalesSummaryFill(
  shopDomain: string,
  shopId: string,
  items: SalesSummaryFillItem[],
  opts: { today?: string | null } = {},
): Promise<EnqueueFillResult> {
  if (items.length === 0) return { usable: true, queued: 0, alreadyQueued: 0 };
  const boss = await ensureSalesSummaryFillWorker();
  if (!boss) return { usable: false, queued: 0, alreadyQueued: 0 };
  let queued = 0;
  let alreadyQueued = 0;
  let failed = 0;
  for (const item of items) {
    const data: SalesSummaryFillJobData = { shopDomain, shopId, ...item };
    try {
      const id = await boss.send(SALES_SUMMARY_FILL_QUEUE_NAME, data, {
        singletonKey: fillSingletonKey(shopId, item.locationGid, item.day),
        priority: opts.today && item.day >= opts.today ? 10 : 0,
        retryLimit: 2,
        retryDelay: 60,
        retryBackoff: true,
      });
      // policy short: 同じ鍵が待っているときは何も積まず null が返る
      if (id) queued += 1;
      else alreadyQueued += 1;
    } catch (e) {
      failed += 1;
      console.warn("[sales-summary fill] enqueue failed", computeFailureReason(e));
    }
  }
  return { usable: failed === 0, queued, alreadyQueued };
}

/** 店の当月 1 日〜昨日（保存の無い日だけ）を積む。店舗設定で売上サマリーをオンにしたとき用 */
export async function enqueueSalesSummaryFillForMonth(
  shopDomain: string,
  shopId: string,
  locations: Array<{ shopifyLocationGid: string; name: string }>,
  today: string,
): Promise<number> {
  if (locations.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return 0;
  const monthStart = `${today.slice(0, 8)}01`;
  const days: string[] = [];
  for (let t = Date.parse(`${monthStart}T00:00:00Z`); ; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d >= today) break;
    days.push(d);
  }
  if (days.length === 0) return 0;
  const ids = locations.flatMap((l) => [l.shopifyLocationGid, l.shopifyLocationGid.replace("gid://shopify/Location/", "")]);
  const cached = await prisma.salesSummaryCacheDaily.findMany({
    where: { shopId, locationId: { in: ids }, targetDate: { gte: monthStart, lt: today } },
    select: { locationId: true, targetDate: true },
  });
  const have = new Set(cached.map((r) => `${r.locationId.replace("gid://shopify/Location/", "")}|${r.targetDate}`));
  const items: SalesSummaryFillItem[] = [];
  for (const loc of locations) {
    const raw = loc.shopifyLocationGid.replace("gid://shopify/Location/", "");
    for (const day of days) {
      if (!have.has(`${raw}|${day}`)) items.push({ locationGid: loc.shopifyLocationGid, locationName: loc.name, day });
    }
  }
  return (await enqueueSalesSummaryFill(shopDomain, shopId, items, { today })).queued;
}

// サーバーが立ち上がったら、すぐワーカーを起こす（再起動の前に積んだジョブを続ける）
if (typeof queueMicrotask !== "undefined" && typeof window === "undefined" && !process.env.NODE_TEST_CONTEXT) {
  queueMicrotask(() => {
    void ensureSalesSummaryFillWorker();
  });
}

/**
 * 店舗設定で売上サマリーをオンにした店の当月分を、裏で数え始める（管理画面の保存から呼ぶ）。
 * 失敗しても保存は止めない（ログだけ。次に POS で開いたときにも積む）。
 */
export async function enqueueSalesSummaryFillForTurnedOn(
  shopId: string,
  locations: Array<{ shopifyLocationGid: string; name: string }>,
): Promise<void> {
  if (locations.length === 0 || queueDisabled()) return;
  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { shopDomain: true } });
    if (!shop?.shopDomain) return;
    const { getAppSetting, GENERAL_SETTINGS_KEY } = await import("../utils/appSettings.server");
    const general = await getAppSetting<{ defaultTimezone?: string }>(shopId, GENERAL_SETTINGS_KEY);
    let tz = general?.defaultTimezone?.trim() || "Asia/Tokyo";
    let today: string;
    try {
      today = getCalendarDateStringInTimeZone(new Date(), tz);
    } catch {
      tz = "Asia/Tokyo";
      today = getCalendarDateStringInTimeZone(new Date(), tz);
    }
    const queued = await enqueueSalesSummaryFillForMonth(shop.shopDomain, shopId, locations, today);
    if (queued > 0) console.log(`[sales-summary fill] queued ${queued} store-days after store settings shop=${shopId}`);
  } catch (e) {
    console.warn("[sales-summary fill] queue after store settings failed", computeFailureReason(e));
  }
}
