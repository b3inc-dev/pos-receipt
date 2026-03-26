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

    if (errors.length > 0) {
      console.warn(
        `[orders/updated][pos-receipt] partial errors shop=${shop} dates=${targetDates.join(",")} count=${errors.length}`,
        errors.slice(0, 8),
      );
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
