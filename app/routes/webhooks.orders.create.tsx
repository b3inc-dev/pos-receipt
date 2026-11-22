/**
 * orders/create Webhook — 販売の帰属スタッフの記録だけ
 *
 * 作成時の本文の line_items[].attributed_staffs（スタッフ ID・数量）を OrderStaffAttribution に記録する。
 * Shopify は呼ばない。売上サマリー・返金計上は orders/updated のまま（ここでは動かさない）。
 * 同じ注文の orders/updated と順番が入れ替わって届いても、updated_at の古い方は捨てる（orderStaffAttribution.server）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { recordOrderStaffAttributionFromWebhook } from "../services/orderStaffAttribution.server";

export const loader = async (_: LoaderFunctionArgs) => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let shop = "";
  let payload: unknown;
  try {
    const auth = await authenticate.webhook(request);
    shop = auth.shop;
    payload = auth.payload;
    const topicStr = String(auth.topic || "").toLowerCase();
    if (topicStr !== "orders/create" && topicStr !== "orders_create") {
      console.log(`[orders/create][pos-receipt] skip wrong topic: ${auth.topic}`);
      return new Response("Invalid topic", { status: 400 });
    }
  } catch (err) {
    // HMAC が合わない・形がおかしい
    console.error("[orders/create][pos-receipt] auth error:", err);
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const dbShop = await prisma.shop.findFirst({ where: { shopDomain: shop } });
    if (!dbShop) return new Response("OK", { status: 200 });
    await recordOrderStaffAttributionFromWebhook(dbShop.id, payload);
  } catch (e) {
    // 記録の失敗で Shopify に再送を繰り返させない（orders/updated で次に入る）
    console.warn(`[orders/create][pos-receipt] staff attribution record failed shop=${shop}`, e);
  }
  return new Response("OK", { status: 200 });
};
