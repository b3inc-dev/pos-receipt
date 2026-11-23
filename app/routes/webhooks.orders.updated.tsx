/**
 * orders/updated Webhook（POS Stock と同様の受信パターン）
 * HMAC 検証後、売上サマリー有効店舗の日次キャッシュを該当暦日分だけ再計算する。
 *
 * @see stock-transfer-pos/app/routes/webhooks.orders.updated.tsx（認証・topic 正規化の参考）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runSalesSummaryRefreshFromOrderWebhook } from "../services/salesSummaryWebhookRefresh.server";
import { enqueueSalesSummaryOrdersUpdatedJob } from "../services/salesSummaryWebhookQueue.server";
import { syncRefundAggregationFromWebhookPayload } from "../services/refundAggregation.server";
import { backgroundRefreshNeedsRetry } from "../services/salesSummaryBackgroundSlice.server";
import {
  registerVoucherFromCartEntry,
  webhookPayloadHasVoucherCartFace,
} from "../services/voucherCartEntry.server";
import {
  applyRefundReservationsForOrder,
  hasPendingReservation,
} from "../services/refundReservation.server";

export const loader = async (_: LoaderFunctionArgs) => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

    const topicStr = String(topic || "").toLowerCase();
    let normalizedTopic = topicStr;
    if (topicStr === "orders_updated") {
      normalizedTopic = "orders/updated";
    } else if (topicStr.includes("_")) {
      normalizedTopic = topicStr.replace(/_([^_]+)$/, "/$1");
    }

    if (normalizedTopic !== "orders/updated") {
      console.log(
        `[orders/updated][pos-receipt] skip wrong topic: ${topic} (normalized: ${normalizedTopic})`,
      );
      return new Response("Invalid topic", { status: 400 });
    }

    if (!session || !admin) {
      console.error(`[orders/updated][pos-receipt] no session/admin shop=${shop}`);
      return new Response("No session", { status: 401 });
    }

    const dbShop = await prisma.shop.findFirst({ where: { shopDomain: shop } });
    if (!dbShop) {
      console.log(`[orders/updated][pos-receipt] shop not in DB, skip refresh: ${shop}`);
      return new Response("OK", { status: 200 });
    }

    // 会計の前に入れた商品券の額面: 会計後の画面で登録できなかったときの拾い直し（docs/VOUCHER_CART_ENTRY.md）。
    // 知らせの中身に項目がある注文だけ読みに行く。失敗しても売上サマリーの処理は続ける
    if (webhookPayloadHasVoucherCartFace(payload)) {
      try {
        const orderId = String((payload as { admin_graphql_api_id?: string; id?: number | string }).admin_graphql_api_id ?? (payload as { id?: number | string }).id ?? "");
        if (orderId) {
          const r = await registerVoucherFromCartEntry(admin, dbShop.id, orderId);
          if (r.status === "created") {
            console.log(`[orders/updated][pos-receipt] voucher from cart entry registered shop=${shop}`);
          }
        }
      } catch (e) {
        console.warn(`[orders/updated][pos-receipt] voucher from cart entry failed shop=${shop}`, e);
      }
    }

    // 返金の予約: その注文に使う前の予約があるときだけ、できた純正の返金に付け替えを作る（docs/REFUND_RESERVATION.md）。
    // 失敗しても売上サマリーの処理は続ける（POS で予約を開くと当て直す）
    try {
      const orderId = String(
        (payload as { admin_graphql_api_id?: string; id?: number | string }).admin_graphql_api_id ??
          (payload as { id?: number | string }).id ??
          "",
      );
      if (orderId && (await hasPendingReservation(dbShop.id, orderId))) {
        const r = await applyRefundReservationsForOrder(admin, dbShop.id, orderId);
        if (r.applied || r.review) {
          console.log(`[orders/updated][pos-receipt] refund reservation applied=${r.applied} review=${r.review} shop=${shop}`);
        }
      }
    } catch (e) {
      console.warn(`[orders/updated][pos-receipt] refund reservation failed shop=${shop}`, e);
    }

    const disabled = process.env.SALES_SUMMARY_WEBHOOK_REFRESH_DISABLED;
    if (disabled === "1" || disabled === "true") {
      return new Response("OK", { status: 200 });
    }

    const queued = await enqueueSalesSummaryOrdersUpdatedJob(shop, payload);
    if (queued) {
      console.log(`[orders/updated][pos-receipt] sales-summary queued shop=${shop}`);
      return new Response("OK", { status: 200 });
    }

    const { targetDates, errors } = await runSalesSummaryRefreshFromOrderWebhook(
      admin,
      dbShop.id,
      payload,
    );

    try {
      await syncRefundAggregationFromWebhookPayload(admin, dbShop.id, payload);
    } catch (e) {
      console.warn(`[orders/updated][pos-receipt] refund aggregation metafield sync failed shop=${shop}`, e);
    }

    if (backgroundRefreshNeedsRetry(errors)) {
      console.warn(
        `[orders/updated][pos-receipt] partial errors shop=${shop} dates=${targetDates.join(",")} count=${errors.length}`,
        errors.slice(0, 8),
      );
      return new Response("Sales summary incomplete", { status: 500 });
    } else {
      console.log(
        `[orders/updated][pos-receipt] sales summary refreshed (sync) shop=${shop} dates=${targetDates.join(",")}`,
      );
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[orders/updated][pos-receipt] error:", err);
    return new Response("Unauthorized", { status: 401 });
  }
};
