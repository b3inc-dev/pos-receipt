/**
 * GDPR 必須コンプライアンス Webhook（App Store 審査で必須）
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * - customers/data_request: 顧客データの開示要求
 * - customers/redact:       顧客データの削除要求
 * - shop/redact:            ショップデータの削除要求（アンインストール 48 時間後）
 *
 * HMAC は verifyShopifyWebhookRequest で自分で確かめる（不正なら 401、ヘッダーが足りなければ 400）。
 * authenticate.webhook() は使わない（事実）: @shopify/shopify-app-react-router 1.1.1 は
 * expiringOfflineAccessTokens のとき期限の切れたトークンを refresh しようとし、アンインストールした店では
 * 失敗して 500 を投げる（ルートの try より前）。shop/redact はアンインストールの 48 時間後に来るので、
 * そのままでは毎回 500 で何も消えなかった（#72 の独立レビューの P1。Shopify は 4.0.3 / ecbcb1b で直した）。
 * それより後の失敗（DB・入っているかの確かめ）は 500 を返す（Shopify はもう一度送る。どの処理も何度来ても安全）。
 * topic は "SHOP_REDACT" の形にそろえてから分ける（normalizeWebhookTopic）。
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
import { unauthenticated, webhookSecret } from "../shopify.server";
import prisma from "../db.server";
import {
  buildCustomerDataInventory,
  expandOrderIdVariants,
  summarizeInventoryForLog,
  type CustomerDataRequestPayload,
} from "../services/gdprCustomerDataRequest.server";
import { redactShopData, type ShopRedactDb } from "../services/shopRedact.server";
import { redactCustomerData, type CustomerRedactDb } from "../services/customerRedact.server";
import {
  INSTALL_PROBE_QUERY,
  probeShopStillInstalled,
} from "../services/shopInstallProbe.server";
import { payloadShopMatchesHeader, verifyShopifyWebhookRequest } from "../services/webhookHmac.server";

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

  // HMAC が不正なら 401（ヘッダーが足りなければ 400）の Response が投げられる（try の外に置いてそのまま返す）
  const { payload, topic: topicStr, shop } = await verifyShopifyWebhookRequest(request, webhookSecret);

  // ヘッダーの店と本文の店（shop_domain）が違うときは何もしない（ほかの店のデータを消さない・出さない）。
  // 送り直しても同じなので 200 を返す
  if (!payloadShopMatchesHeader(payload, shop)) {
    console.warn(`[webhooks.compliance] ${topicStr} shop=${shop} skipped: shop_domain does not match header`);
    return new Response(null, { status: 200 });
  }

  try {
    if (topicStr === "CUSTOMERS_DATA_REQUEST") {
      const body = payload as CustomerDataRequestPayload;
      const shopDomain = shop;
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
      // 顧客データの削除要求（T さん 11/23 2:35）。
      // 指定注文の領収書の宛名を空にし（再印字で空）、特殊返金のメモを消す（金額・日時は残す）。
      const body = payload as {
        shop_domain?: string;
        orders_to_redact?: Array<number | string>;
      };
      await redactCustomerData({
        db: prisma as unknown as CustomerRedactDb,
        shopDomain: shop,
        ordersToRedact: body.orders_to_redact,
      });
      return new Response(null, { status: 200 });
    }

    if (topicStr === "SHOP_REDACT") {
      // ショップデータの削除要求（アンインストール 48 時間後）。
      // 使用量の記録（AppUsageReport）・セッション・Shop（CASCADE で関連テーブルも）を消す。
      // 48 時間のうちに入れ直した店なら何も消さない。
      const shopDomain = shop;

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
    // ライブラリの refresh の失敗は Response(500) で来る（入れ直した店の確かめ unauthenticated.admin の中）
    const reason =
      err instanceof Response
        ? `Response ${err.status} (token refresh or Admin API failed)`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`[webhooks.compliance] ${topicStr} shop=${shop} failed:`, reason);
    return new Response(null, { status: 500 });
  }
};
