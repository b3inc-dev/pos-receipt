import "@shopify/shopify-app-react-router/adapters/node";
import { ApiVersion, shopifyApp } from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// 環境変数は前後の空白・改行をトリムする（Render 等でコピペ時に \n が入ると JWT 検証で 401 になる）
const apiKey = process.env.SHOPIFY_API_KEY?.trim() ?? "";
const apiSecretKey = process.env.SHOPIFY_API_SECRET?.trim() ?? "";

const shopify = shopifyApp({
  apiKey,
  apiSecretKey,
  // shopify.app*.toml と揃える。refundCreate の @idempotent は 2026-01 以降。
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(",").map((s) => s.trim()).filter(Boolean),
  appUrl: process.env.SHOPIFY_APP_URL?.trim() ?? "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  future: {
    expiringOfflineAccessTokens: true,
  },
});

export default shopify;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;

/** pg-boss ワーカーをプロセス起動直後に温める（初回 Webhook まで待たない） */
if (typeof queueMicrotask !== "undefined") {
  queueMicrotask(() => {
    import("./services/salesSummaryWebhookQueue.server")
      .then((m) => m.ensureSalesSummaryWebhookWorker())
      .catch(() => {});
    // ciara-system の予算の取り込み（自社用で鍵があるときだけ動く）
    import("./services/ciaraBudgetSync.server")
      .then((m) => m.ensureCiaraBudgetSyncScheduler())
      .catch(() => {});
    // ciara-system の入店数を読む（自社用でサーバーの準備ができているときだけ動く）
    import("./services/ciaraVisitSync.server")
      .then((m) => m.ensureCiaraVisitSyncScheduler())
      .catch(() => {});
  });
}
