/**
 * APP_UNINSTALLED webhook
 * アプリのアンインストール時にセッションを削除する。
 *
 * authenticate.webhook() は使わない（事実）: @shopify/shopify-app-react-router 1.1.1 は
 * expiringOfflineAccessTokens のとき、期限の切れたトークンを refresh しようとし、アンインストールした店では
 * 失敗して 500 を投げる（ルートより前）。そうなるとセッションが消えず、shop/redact の
 * 「セッションが残っていれば入れ直した」の前提も崩れる。そのため HMAC だけ自分で確かめる
 * （verifyShopifyWebhookRequest。不正なら 401）。セッションは読まない・refresh しない。
 *
 * 何度来ても同じ結果（deleteMany）。失敗したら 500 を返し、Shopify にもう一度送ってもらう。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { webhookSecret } from "../shopify.server";
import prisma from "../db.server";
import { verifyShopifyWebhookRequest } from "../services/webhookHmac.server";

export const loader = async (_: LoaderFunctionArgs) => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // 不正なら 405 / 400 / 401 の Response が投げられ、そのまま返る
  const { shop } = await verifyShopifyWebhookRequest(request, webhookSecret);

  try {
    const result = await prisma.session.deleteMany({ where: { shop } });
    console.info(`[webhooks.app.uninstalled] shop=${shop} sessions=${result.count}`);
    return new Response(null, { status: 200 });
  } catch (err) {
    console.error(
      `[webhooks.app.uninstalled] shop=${shop} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return new Response(null, { status: 500 });
  }
};
