/**
 * 返金処理中（pending）のまま数分たった特殊返金の定期の見回り（pg-boss の schedule・5 分ごと）。
 * 精算や POS の一覧を開かなくても、アプリが自動で Shopify を読み直して success / failed に決める（T 2026-11-23 4:25）。
 *
 * - 売上サマリーのキュー（salesSummaryWebhookQueue.server.ts）と同じ pg-boss を使う。
 *   そのキューが無効（SALES_SUMMARY_WEBHOOK_QUEUE=0）や DATABASE_URL が無いときは見回りも動かない
 *   （精算・POS の一覧の中で決める道は動く）。
 * - 自動の確定は既定でオフ。SPECIAL_REFUND_AUTO_RESOLVE=1 のときだけ動く（未設定・0 は止まる）。
 * - schedule は pg-boss が 1 回の時刻に 1 つだけ積むので、Render のインスタンスが複数でも重ならない。
 *   重なっても、DB の書き換えは pending・updatedAt が同じ行だけなので 2 回決めない。
 */
import type PgBoss from "pg-boss";
import prisma from "../db.server";
import { autoResolveStalePendingSpecialRefunds } from "./specialRefundAutoResolve.server";
import {
  autoResolveAfterMs,
  isAutoResolveDisabled,
} from "./specialRefundAutoResolvePure.server";
import { POS_SPECIAL_REFUND_EVENT_ID_PREFIX } from "./specialRefundLegacyRecheck.server";

export const SPECIAL_REFUND_AUTO_RESOLVE_QUEUE_NAME = "pos-receipt-special-refund-auto-resolve";
const SWEEP_CRON = "*/5 * * * *";
/** 1 回の見回りで見る店の上限 */
const SWEEP_SHOP_LIMIT = 50;

/** 見回りの本体。決めた件数を返す */
export async function runSpecialRefundAutoResolveSweep(): Promise<number> {
  if (isAutoResolveDisabled()) return 0;
  const cutoff = new Date(Date.now() - autoResolveAfterMs());
  const shops = await prisma.specialRefundEvent.findMany({
    where: {
      status: "active",
      shopifyRefundStatus: "pending",
      updatedAt: { lte: cutoff },
      id: { startsWith: POS_SPECIAL_REFUND_EVENT_ID_PREFIX },
    },
    distinct: ["shopId"],
    select: { shopId: true },
    take: SWEEP_SHOP_LIMIT,
  });
  if (shops.length === 0) return 0;

  const { unauthenticated } = await import("../shopify.server");
  let resolved = 0;
  for (const { shopId } of shops) {
    try {
      const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { shopDomain: true } });
      if (!shop?.shopDomain) continue;
      const { admin } = await unauthenticated.admin(shop.shopDomain);
      const result = await autoResolveStalePendingSpecialRefunds(
        admin,
        shopId,
        { onlyKeyedEvents: true },
        { refreshDailySummary: true },
      );
      resolved += result.resolved.length;
    } catch (e) {
      // オフラインのセッションが無い（アンインストール済み等）・Shopify に届かない → 次の見回りで
      console.warn(`[special-refunds] auto-resolve sweep failed shopId=${shopId}`, e);
    }
  }
  return resolved;
}

/** startBossAndWorker から 1 回呼ぶ */
export async function registerSpecialRefundAutoResolveSweep(boss: PgBoss): Promise<void> {
  if (isAutoResolveDisabled()) {
    await boss.unschedule(SPECIAL_REFUND_AUTO_RESOLVE_QUEUE_NAME).catch(() => {});
    return;
  }
  await boss
    .createQueue(SPECIAL_REFUND_AUTO_RESOLVE_QUEUE_NAME)
    .catch(() => {
      /* キューが既にある */
    });
  await boss.schedule(SPECIAL_REFUND_AUTO_RESOLVE_QUEUE_NAME, SWEEP_CRON, {}, { retryLimit: 0 });
  await boss.work(
    SPECIAL_REFUND_AUTO_RESOLVE_QUEUE_NAME,
    { pollingIntervalSeconds: 30 },
    async () => {
      const n = await runSpecialRefundAutoResolveSweep();
      if (n > 0) console.log(`[pg-boss] special-refund auto-resolve resolved=${n}`);
    },
  );
}
