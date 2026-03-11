/**
 * GDPR 必須コンプライアンス Webhook（App Store 審査で必須）
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * - customers/data_request: 顧客データの開示要求
 * - customers/redact:       顧客データの削除要求
 * - shop/redact:            ショップデータの削除要求（アンインストール 48 時間後）
 *
 * HMAC 検証は authenticate.webhook(request) 内で実施され、不正な場合は 401 を返す。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async (_: LoaderFunctionArgs) => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { payload, topic, shop } = await authenticate.webhook(request);
    const topicStr = String(topic ?? "");

    if (topicStr === "customers/data_request") {
      // 顧客データの開示要求。
      // 本アプリは顧客の個人情報（メール・電話番号等）を個別には保存しておらず、
      // 領収書の宛名（任意入力テキスト）のみを保存している。
      // App Store 審査上は 200 を返すことで要求を受理した扱いとなる。
      return new Response(null, { status: 200 });
    }

    if (topicStr === "customers/redact") {
      // 顧客データの削除要求。
      // 指定注文 ID に紐づく領収書発行履歴の宛名を匿名化する。
      const body = payload as {
        shop_domain?: string;
        orders_to_redact?: number[];
      };
      const shopDomain = body.shop_domain ?? shop;
      const orderIds = (body.orders_to_redact ?? []).map(String);

      if (orderIds.length > 0) {
        // 対象注文の領収書発行履歴の宛名を匿名化
        const dbShop = await prisma.shop.findFirst({ where: { shopDomain } });
        if (dbShop) {
          await prisma.receiptIssue.updateMany({
            where: { shopId: dbShop.id, orderId: { in: orderIds } },
            data: { recipientName: "[redacted]" },
          });
        }
      }
      return new Response(null, { status: 200 });
    }

    if (topicStr === "shop/redact") {
      // ショップデータの削除要求（アンインストール 48 時間後）。
      // 当該ショップの全データをカスケード削除する。
      const body = payload as { shop_domain?: string };
      const shopDomain = body.shop_domain ?? shop;

      // セッション削除
      await prisma.session.deleteMany({ where: { shop: shopDomain } });

      // Shop レコード削除（CASCADE で関連テーブルも全削除）
      const dbShop = await prisma.shop.findFirst({ where: { shopDomain } });
      if (dbShop) {
        await prisma.shop.delete({ where: { id: dbShop.id } });
      }

      return new Response(null, { status: 200 });
    }

    return new Response(null, { status: 200 });
  } catch (err) {
    console.error("[webhooks.compliance] Error:", err);
    return new Response("Unauthorized", { status: 401 });
  }
};
