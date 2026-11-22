/**
 * アンインストールと必須 webhook（customers/data_request・customers/redact・shop/redact）を、
 * トークンの refresh をせずに確かめる部品。
 *
 * なぜ要るか（事実・#72 の独立レビューの P1）:
 * - このアプリは `future.expiringOfflineAccessTokens: true`。
 * - @shopify/shopify-app-react-router 1.1.1 の `authenticate.webhook()` は、HMAC を確かめたあと必ず
 *   オフラインのセッションを読み、期限が切れていれば refresh する。アンインストールした店では refresh が
 *   失敗し、ライブラリが `Response(500)` を投げる（ルートの try より前）。
 * - そのため app/uninstalled ではセッションが消えず、48 時間後の shop/redact も毎回 500 で何も消えない。
 * - Shopify は 4.0.3（ecbcb1b）で直したが、1.1.1 → 4.x は大きな版の上げ（Node 22 必須・Polaris 2 が既定・
 *   セッションの保存の部品の版上げなど）になるので、この 2 つのルートだけ自分で確かめる。
 *
 * ここでは:
 * - POST 以外 → 405
 * - HMAC・topic・店のヘッダーが無い → 400（ライブラリと同じ）
 * - HMAC が合わない → 401（ライブラリと同じ。Shopify の審査の自動の確かめもこれを見る）
 * - 本文が JSON でない → 400
 * - 合えば、本文・店・topic（"SHOP_REDACT" の形）を返す。セッションは読まない・refresh しない。
 *
 * HMAC の作り方は Shopify の決まりどおり（本文のバイト列を client secret で HMAC-SHA256 → base64）。
 * 比べるのは `timingSafeEqual`。本文・秘密の値は記録（ログ）に出さない。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeWebhookTopic } from "./shopInstallProbe.server";

export type VerifiedWebhook = {
  /** 例: "SHOP_REDACT"（normalizeWebhookTopic 済み） */
  topic: string;
  /** 例: "example.myshopify.com" */
  shop: string;
  webhookId: string | null;
  apiVersion: string | null;
  payload: unknown;
};

/** 本文のバイト列から Shopify と同じ HMAC（base64）を作る */
export function computeWebhookHmac(rawBody: Uint8Array | string, secret: string): string {
  return createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody))
    .digest("base64");
}

/** ヘッダーの HMAC が本文と合うか（長さが違う・空でも投げない） */
export function isValidWebhookHmac(
  rawBody: Uint8Array | string,
  hmacHeader: string | null | undefined,
  secret: string,
): boolean {
  const given = String(hmacHeader ?? "").trim();
  if (!given || !secret) return false;
  const expected = Buffer.from(computeWebhookHmac(rawBody, secret), "utf8");
  const actual = Buffer.from(given, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * webhook のリクエストを確かめる。だめなら Response（405 / 400 / 401）を投げる。
 * `authenticate.webhook()` と同じく、ルートでは try の外で呼ぶ（だめなときはその状態のまま返る）。
 */
export async function verifyShopifyWebhookRequest(
  request: Request,
  secret: string,
): Promise<VerifiedWebhook> {
  if (request.method !== "POST") {
    throw new Response(undefined, { status: 405, statusText: "Method not allowed" });
  }

  const hmac = request.headers.get("x-shopify-hmac-sha256");
  const topicHeader = request.headers.get("x-shopify-topic");
  const shop = request.headers.get("x-shopify-shop-domain");
  if (!hmac || !topicHeader || !shop) {
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  if (!isValidWebhookHmac(raw, hmac, secret)) {
    throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }

  return {
    topic: normalizeWebhookTopic(topicHeader),
    shop: shop.trim(),
    webhookId: request.headers.get("x-shopify-webhook-id"),
    apiVersion: request.headers.get("x-shopify-api-version"),
    payload,
  };
}
