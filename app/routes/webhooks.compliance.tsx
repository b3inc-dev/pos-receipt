/**
 * GDPR 必須コンプライアンス Webhook（App Store 審査で必須）
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * - customers/data_request: 顧客データの開示要求
 * - customers/redact:       顧客データの削除要求
 * - shop/redact:            ショップデータの削除要求（アンインストール 48 時間後）
 *
 * HMAC 検証は authenticate.webhook(request) 内で実施され、不正な場合は 401 を返す。
 * それより後の失敗（DB・入っているかの確かめ）は 500 を返す（Shopify はもう一度送る。どの処理も何度来ても安全）。
 * topic は "SHOP_REDACT" の形で来るので normalizeWebhookTopic でそろえてから分ける。
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
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import {
  buildCustomerDataInventory,
  expandOrderIdVariants,
  summarizeInventoryForLog,
  type CustomerDataRequestPayload,
} from "../services/gdprCustomerDataRequest.server";
import { redactShopData, type ShopRedactDb } from "../services/shopRedact.server";
import {
  INSTALL_PROBE_QUERY,
  normalizeWebhookTopic,
  probeShopStillInstalled,
} from "../services/shopInstallProbe.server";

/** 入れ直した店か（オフラインのセッションがあり、Admin API を呼べる） */
async function isShopStillInstalled(shop: string): Promise<boolean> {
  return probeShopStillInstalled({
    shop,
    findOfflineSession: (s) => prisma.session.findFirst({ where: { shop: s, isOnline: false } }),
    runProbeQuery: async (s) => {
      const { admin } = await unauthenticated.admin(s);
      const resp = await admin.graphql(INSTALL_PROBE_QUERY);
      const body = (await resp.json()) as { data?: { shop?: { id?: string } }; errors?: unknown };
      if (!body?.data?.shop?.id) {
        throw new Error(`install probe returned no shop: ${JSON.stringify(body?.errors ?? null)}`);
      }
      return body;
    },
  });
}

export const loader = async (_: LoaderFunctionArgs) => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // HMAC が不正なら authenticate.webhook が 401 の Response を投げる（try の外に置いて 401 のまま返す）
  const { payload, topic, shop } = await authenticate.webhook(request);
  const topicStr = normalizeWebhookTopic(topic);

  try {
    if (topicStr === "CUSTOMERS_DATA_REQUEST") {
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

    if (topicStr === "CUSTOMERS_REDACT") {
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

    if (topicStr === "SHOP_REDACT") {
      // ショップデータの削除要求（アンインストール 48 時間後）。
      // 使用量の記録（AppUsageReport）・セッション・Shop（CASCADE で関連テーブルも）を消す。
      // 48 時間のうちに入れ直した店なら何も消さない。
      const body = payload as { shop_domain?: string };
      const shopDomain = body.shop_domain ?? shop;

      await redactShopData({
        db: prisma as unknown as ShopRedactDb,
        shopDomain,
        isShopStillInstalled,
      });

      return new Response(null, { status: 200 });
    }

    return new Response(null, { status: 200 });
  } catch (err) {
    // DB の失敗・入っているか確かめられないとき。500 を返し、Shopify にもう一度送ってもらう。
    console.error(
      `[webhooks.compliance] ${topicStr} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return new Response(null, { status: 500 });
  }
};
