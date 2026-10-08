/**
 * GDPR 必須コンプライアンス Webhook（App Store 審査で必須）
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * - customers/data_request: 顧客データの開示要求
 * - customers/redact:       顧客データの削除要求
 * - shop/redact:            ショップデータの削除要求（アンインストール 48 時間後）
 *
 * HMAC 検証は authenticate.webhook(request) 内で実施され、不正な場合は 401 を返す。
 *
 * customers/data_request 方針:
 * - Shopify への必須応答は 200（受理）。開示データ本体は webhook レスポンスに載せない。
 * - アプリ DB に customer.email / phone は保存していない（根拠は inventory.rationale）。
 * - 注文 ID に紐づく ReceiptIssue / SpecialRefundEvent を列挙し、PII 本文を含めない
 *   サマリのみログする（新規の個人情報永続化は行わない）。
 * - ストアオーナーへの開示は 30 日以内の運用（管理画面の領収書・特殊返金履歴、
 *   またはサポート連絡先）で対応する。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  buildCustomerDataInventory,
  expandOrderIdVariants,
  summarizeInventoryForLog,
  type CustomerDataRequestPayload,
} from "../services/gdprCustomerDataRequest.server";

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
      const body = payload as CustomerDataRequestPayload;
      const shopDomain = body.shop_domain ?? shop;
      const orderVariants = expandOrderIdVariants(body.orders_requested);

      let receiptIssues: Awaited<ReturnType<typeof prisma.receiptIssue.findMany>> = [];
      let specialRefundEvents: Awaited<
        ReturnType<typeof prisma.specialRefundEvent.findMany>
      > = [];

      const dbShop = await prisma.shop.findFirst({ where: { shopDomain } });
      if (dbShop && orderVariants.length > 0) {
        [receiptIssues, specialRefundEvents] = await Promise.all([
          prisma.receiptIssue.findMany({
            where: { shopId: dbShop.id, orderId: { in: orderVariants } },
            select: {
              orderId: true,
              orderName: true,
              recipientName: true,
              amount: true,
              currency: true,
              proviso: true,
              locationId: true,
              createdAt: true,
              isReissue: true,
            },
          }),
          prisma.specialRefundEvent.findMany({
            where: { shopId: dbShop.id, sourceOrderId: { in: orderVariants } },
            select: {
              sourceOrderId: true,
              sourceOrderName: true,
              eventType: true,
              amount: true,
              currency: true,
              originalPaymentMethod: true,
              actualRefundMethod: true,
              note: true,
              status: true,
              createdAt: true,
            },
          }),
        ]);
      }

      const inventory = buildCustomerDataInventory({
        shopDomain,
        payload: body,
        receiptIssues,
        specialRefundEvents,
      });

      // PII 本文（宛名等）はログに出さない。新規 DB 行も作らない。
      console.info(
        "[webhooks.compliance] customers/data_request inventory",
        JSON.stringify(summarizeInventoryForLog(inventory))
      );

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
      const orderIds = expandOrderIdVariants(body.orders_to_redact);

      if (orderIds.length > 0) {
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
