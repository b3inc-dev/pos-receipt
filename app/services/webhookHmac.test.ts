import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  computeWebhookHmac,
  isValidWebhookHmac,
  payloadShopMatchesHeader,
  verifyShopifyWebhookRequest,
} from "./webhookHmac.server";

const SECRET = "test-secret";
const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("base64");

function req(
  body: string,
  {
    method = "POST",
    hmac = sign(body),
    topic = "shop/redact" as string | null,
    shop = "example.myshopify.com" as string | null,
  } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (hmac !== null) headers.set("X-Shopify-Hmac-Sha256", hmac);
  if (topic !== null) headers.set("X-Shopify-Topic", topic);
  if (shop !== null) headers.set("X-Shopify-Shop-Domain", shop);
  headers.set("X-Shopify-Webhook-Id", "wh-1");
  headers.set("X-Shopify-API-Version", "2025-10");
  return new Request("https://app.example.com/webhooks/compliance", {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  });
}

async function statusOfThrown(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Response, "Response を投げる");
    return e.status;
  }
  assert.fail("投げるはず");
}

describe("computeWebhookHmac / isValidWebhookHmac", () => {
  it("Shopify と同じ形（HMAC-SHA256 → base64）", () => {
    const body = '{"shop_domain":"example.myshopify.com"}';
    assert.equal(computeWebhookHmac(body, SECRET), sign(body));
    assert.equal(isValidWebhookHmac(body, sign(body), SECRET), true);
  });

  it("日本語を含む本文もバイト列で合う", () => {
    const body = '{"note":"宛名 山田"}';
    assert.equal(isValidWebhookHmac(new TextEncoder().encode(body), sign(body), SECRET), true);
  });

  it("違う秘密・空・長さ違いは false（投げない）", () => {
    const body = "{}";
    assert.equal(isValidWebhookHmac(body, sign(body, "other"), SECRET), false);
    assert.equal(isValidWebhookHmac(body, "", SECRET), false);
    assert.equal(isValidWebhookHmac(body, null, SECRET), false);
    assert.equal(isValidWebhookHmac(body, "abc", SECRET), false);
    assert.equal(isValidWebhookHmac(body, sign(body), ""), false);
  });
});

describe("verifyShopifyWebhookRequest（refresh しない確かめ）", () => {
  it("正しい HMAC なら topic をそろえて本文・店を返す", async () => {
    const body = JSON.stringify({ shop_domain: "example.myshopify.com", shop_id: 1 });
    const v = await verifyShopifyWebhookRequest(req(body), SECRET);
    assert.equal(v.topic, "SHOP_REDACT");
    assert.equal(v.shop, "example.myshopify.com");
    assert.equal(v.webhookId, "wh-1");
    assert.equal(v.apiVersion, "2025-10");
    assert.deepEqual(v.payload, { shop_domain: "example.myshopify.com", shop_id: 1 });
  });

  it("topic: app/uninstalled → APP_UNINSTALLED、customers/data_request → CUSTOMERS_DATA_REQUEST", async () => {
    const body = "{}";
    assert.equal((await verifyShopifyWebhookRequest(req(body, { topic: "app/uninstalled" }), SECRET)).topic, "APP_UNINSTALLED");
    assert.equal(
      (await verifyShopifyWebhookRequest(req(body, { topic: "customers/data_request" }), SECRET)).topic,
      "CUSTOMERS_DATA_REQUEST",
    );
  });

  it("HMAC が合わない → 401", async () => {
    const body = "{}";
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(req(body, { hmac: sign(body, "x") }), SECRET)), 401);
  });

  it("本文を書き換えたら 401", async () => {
    const r = req('{"a":2}', { hmac: sign('{"a":1}') });
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(r, SECRET)), 401);
  });

  it("HMAC・topic・店のヘッダーが無い → 400", async () => {
    const body = "{}";
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(req(body, { hmac: null }), SECRET)), 400);
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(req(body, { topic: null }), SECRET)), 400);
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(req(body, { shop: null }), SECRET)), 400);
  });

  it("HMAC は合うが JSON でない → 400", async () => {
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(req("not json"), SECRET)), 400);
  });

  it("POST 以外 → 405", async () => {
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(req("", { method: "GET" }), SECRET)), 405);
  });

  it("秘密が空なら必ず 401（設定漏れで通さない）", async () => {
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(req("{}"), "")), 401);
  });

  it("本文が上限より大きい → 413（Content-Length で読む前に断る）", async () => {
    const body = JSON.stringify({ shop_domain: "example.myshopify.com", pad: "x".repeat(200) });
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(req(body), SECRET, { maxBodyBytes: 100 })), 413);
  });

  it("Content-Length が無くても、読みながら上限を超えたら 413", async () => {
    const body = "x".repeat(300);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body.slice(0, 150)));
        controller.enqueue(new TextEncoder().encode(body.slice(150)));
        controller.close();
      },
    });
    const headers = new Headers({
      "X-Shopify-Hmac-Sha256": sign(body),
      "X-Shopify-Topic": "shop/redact",
      "X-Shopify-Shop-Domain": "example.myshopify.com",
    });
    const r = new Request("https://app.example.com/webhooks/compliance", {
      method: "POST",
      headers,
      body: stream,
      // @ts-expect-error Node の fetch はストリームの本文に duplex が要る
      duplex: "half",
    });
    assert.equal(await statusOfThrown(verifyShopifyWebhookRequest(r, SECRET, { maxBodyBytes: 100 })), 413);
  });

  it("上限ちょうどまでは通す", async () => {
    const body = JSON.stringify({ shop_domain: "example.myshopify.com" });
    const v = await verifyShopifyWebhookRequest(req(body), SECRET, { maxBodyBytes: Buffer.byteLength(body) });
    assert.equal(v.shop, "example.myshopify.com");
  });
});

describe("payloadShopMatchesHeader", () => {
  it("shop_domain・myshopify_domain がヘッダーと同じなら true（大文字・空白は区別しない）", () => {
    assert.equal(payloadShopMatchesHeader({ shop_domain: "Example.myshopify.com " }, "example.myshopify.com"), true);
    assert.equal(payloadShopMatchesHeader({ myshopify_domain: "example.myshopify.com" }, "example.myshopify.com"), true);
  });

  it("違えば false", () => {
    assert.equal(payloadShopMatchesHeader({ shop_domain: "other.myshopify.com" }, "example.myshopify.com"), false);
    assert.equal(payloadShopMatchesHeader({ myshopify_domain: "other.myshopify.com" }, "example.myshopify.com"), false);
    assert.equal(
      payloadShopMatchesHeader({ shop_domain: "example.myshopify.com", myshopify_domain: "other.myshopify.com" }, "example.myshopify.com"),
      false,
    );
  });

  it("本文に店が無いときは比べられないので true", () => {
    assert.equal(payloadShopMatchesHeader({}, "example.myshopify.com"), true);
    assert.equal(payloadShopMatchesHeader(null, "example.myshopify.com"), true);
  });
});
