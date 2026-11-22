import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNotInstalledError,
  normalizeWebhookTopic,
  probeShopStillInstalled,
} from "./shopInstallProbe.server";

describe("probeShopStillInstalled", () => {
  it("オフラインのセッションが無ければ、入っていない（API は呼ばない）", async () => {
    let called = 0;
    const res = await probeShopStillInstalled({
      shop: "a.myshopify.com",
      findOfflineSession: async () => null,
      runProbeQuery: async () => {
        called += 1;
      },
    });
    assert.equal(res, false);
    assert.equal(called, 0);
  });

  it("セッションがあり API を呼べたら、入れ直している", async () => {
    const res = await probeShopStillInstalled({
      shop: "a.myshopify.com",
      findOfflineSession: async () => ({ id: "offline_a.myshopify.com" }),
      runProbeQuery: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }),
    });
    assert.equal(res, true);
  });

  it("API が 401（トークンが無効）なら、入っていない", async () => {
    const res = await probeShopStillInstalled({
      shop: "a.myshopify.com",
      findOfflineSession: async () => ({ id: "x" }),
      runProbeQuery: async () => {
        throw new Response(null, { status: 401 });
      },
    });
    assert.equal(res, false);
  });

  it("通信の失敗・5xx・403 は分からないので投げる", async () => {
    for (const err of [new Error("ECONNRESET"), { response: { code: 503 } }, { status: 403 }]) {
      await assert.rejects(
        probeShopStillInstalled({
          shop: "a.myshopify.com",
          findOfflineSession: async () => ({ id: "x" }),
          runProbeQuery: async () => {
            throw err;
          },
        }),
      );
    }
  });

  it("セッションを読むのに失敗（DB の失敗）したら投げる", async () => {
    await assert.rejects(
      probeShopStillInstalled({
        shop: "a.myshopify.com",
        findOfflineSession: async () => {
          throw new Error("db down");
        },
        runProbeQuery: async () => ({}),
      }),
      /db down/,
    );
  });
});

describe("isNotInstalledError", () => {
  it("401 とトークンが無効の文言を、入っていないと見る", () => {
    assert.equal(isNotInstalledError({ response: { code: 401 } }), true);
    assert.equal(isNotInstalledError({ statusCode: 401 }), true);
    assert.equal(isNotInstalledError(new Error("[API] Invalid API key or access token")), true);
    assert.equal(isNotInstalledError(new Error("SessionNotFoundError: Could not find a session")), true);
  });
  it("それ以外は入っていないと見ない", () => {
    assert.equal(isNotInstalledError({ status: 403 }), false);
    assert.equal(isNotInstalledError(new Error("timeout")), false);
    assert.equal(isNotInstalledError(null), false);
  });
});

describe("normalizeWebhookTopic", () => {
  it("authenticate.webhook の形（SHOP_REDACT）とヘッダーの形（shop/redact）を同じにする", () => {
    assert.equal(normalizeWebhookTopic("SHOP_REDACT"), "SHOP_REDACT");
    assert.equal(normalizeWebhookTopic("shop/redact"), "SHOP_REDACT");
    assert.equal(normalizeWebhookTopic(" customers/data_request "), "CUSTOMERS_DATA_REQUEST");
    assert.equal(normalizeWebhookTopic("CUSTOMERS_REDACT"), "CUSTOMERS_REDACT");
    assert.equal(normalizeWebhookTopic(undefined), "");
  });
});
