/**
 * APP_UNINSTALLED webhook
 * アプリのアンインストール時にセッションを削除する
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session } = await authenticate.webhook(request);

  // Webhook は複数回発火することがある（アンインストール済みの場合 session は null）
  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
