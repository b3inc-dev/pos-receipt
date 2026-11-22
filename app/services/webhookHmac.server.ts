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
 * - 本文が大きすぎる（初めは 1 MiB 超え）→ 413（読む前に Content-Length で、読みながらも数えて止める）
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

/** アンインストール・必須 webhook の本文の上限（これらの本文は数 KB。大きなものは読まずに断る） */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

const tooLarge = () => new Response(undefined, { status: 413, statusText: "Payload Too Large" });

/** 本文を上限まで読む。上限を超えたら 413 を投げる（全部を読みきらない） */
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** 店のドメインのそろえ方（大文字・小文字と前後の空白を区別しない） */
function shopKey(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/**
 * ヘッダーの店（X-Shopify-Shop-Domain）と本文の店が同じか。
 * 必須 webhook は `shop_domain`、app/uninstalled は店そのもの（`myshopify_domain`）が本文に入る。
 * 本文にどちらも無いときは比べられないので同じとみなす。違えば、その webhook では何もしない。
 */
export function payloadShopMatchesHeader(payload: unknown, headerShop: string): boolean {
  if (!payload || typeof payload !== "object") return true;
  const body = payload as { shop_domain?: unknown; myshopify_domain?: unknown };
  const header = shopKey(headerShop);
  for (const v of [body.shop_domain, body.myshopify_domain]) {
    if (v === undefined || v === null) continue;
    if (shopKey(v) !== header) return false;
  }
  return true;
}

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
  { maxBodyBytes = MAX_WEBHOOK_BODY_BYTES }: { maxBodyBytes?: number } = {},
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

  const raw = await readBodyWithLimit(request, maxBodyBytes);
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
