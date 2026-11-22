/**
 * orders/updated（キュー経由）で、注文の返金計上ロケーション
 * （pos.refund_aggregation_location_gid）を書く。
 *
 * 同期経路（webhooks.orders.updated.tsx）と同じく、失敗してもログだけ出して投げない。
 * 売上サマリーの再計算（とその再試行）を返金計上店の書き込みで止めないため。
 *
 * 実際の書き込み関数は呼び出し側から渡す（テストで prisma / Admin API を読み込まないため）。
 */
export type RefundAggregationWebhookSyncFn<A> = (
  admin: A,
  shopId: string,
  payload: unknown,
) => Promise<void>;

export type RefundAggregationWebhookSyncLogger = {
  warn: (message: string, err: unknown) => void;
};

/**
 * @returns 書き込み関数が投げずに終わったら true、投げたら false（ログ済み）
 */
export async function syncRefundAggregationForQueuedWebhook<A>(
  sync: RefundAggregationWebhookSyncFn<A>,
  admin: A,
  shopId: string,
  shopDomain: string,
  payload: unknown,
  logger: RefundAggregationWebhookSyncLogger = console,
): Promise<boolean> {
  try {
    await sync(admin, shopId, payload);
    return true;
  } catch (e) {
    logger.warn(
      `[pg-boss] refund aggregation metafield sync failed shop=${shopDomain}`,
      e,
    );
    return false;
  }
}
