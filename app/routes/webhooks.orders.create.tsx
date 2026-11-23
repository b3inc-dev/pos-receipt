/**
 * orders/create Webhook。
 * 会計の前に入れた商品券の額面（注文の見えない項目 `_pos_receipt_voucher_face`）がある注文だけ、商品券調整を自動で登録する
 * （会計後の画面のブロックが出なかった・失敗したときの予備。作ったあと更新の無い注文は orders/updated が来ないことがあるため）。
 * docs/VOUCHER_CART_ENTRY.md。額面の項目が無い注文では Shopify を読まない。売上サマリー・返金計上は動かさない（orders/updated のまま）。
 * 失敗してもログだけで 200 を返す（再送を繰り返させない。会計後の画面・orders/updated・POS の一覧でも拾える）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runOrderAutoAdjustmentsFromWebhook } from "../services/orderAutoAdjustments.server";
import { webhookPayloadHasVoucherCartFace } from "../services/voucherCartEntryPure";

export const loader = async (_: LoaderFunctionArgs) => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const { topic, shop, session, admin, payload } = await authenticate.webhook(request);
    const t = String(topic || "").toLowerCase();
    if (t !== "orders/create" && t !== "orders_create") {
      return new Response("Invalid topic", { status: 400 });
    }
    // 額面の項目が無い注文（ほとんど）は何もしない
    if (!webhookPayloadHasVoucherCartFace(payload)) return new Response("OK", { status: 200 });
    if (!session || !admin) {
      console.error(`[orders/create][pos-receipt] no session/admin shop=${shop}`);
      return new Response("OK", { status: 200 });
    }
    const dbShop = await prisma.shop.findFirst({ where: { shopDomain: shop } });
    if (!dbShop) return new Response("OK", { status: 200 });
    try {
      await runOrderAutoAdjustmentsFromWebhook(admin, dbShop.id, shop, payload);
    } catch (e) {
      console.warn(`[orders/create][pos-receipt] auto adjustments failed shop=${shop}`, e);
    }
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[orders/create][pos-receipt] error:", err);
    return new Response("Unauthorized", { status: 401 });
  }
};
