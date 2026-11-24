import { test } from "node:test";
import assert from "node:assert/strict";
import { redactLogUrl } from "./redactLogUrl.mjs";

test("ログの URL: トークン・session・hmac の値を伏せ、日付などは残す", () => {
  assert.equal(
    redactLogUrl("/app/settings?embedded=1&hmac=abc&host=xx&id_token=eyJ.a.b&session=s1&shop=x.myshopify.com"),
    "/app/settings?embedded=1&hmac=-&host=xx&id_token=-&session=-&shop=x.myshopify.com",
  );
  assert.equal(
    redactLogUrl("/api/sales-summary/period?loadId=abc123&dateFrom=2026-11-01&dateTo=2026-11-23"),
    "/api/sales-summary/period?loadId=abc123&dateFrom=2026-11-01&dateTo=2026-11-23",
  );
  assert.equal(redactLogUrl("/healthz"), "/healthz");
  assert.equal(redactLogUrl("/x?ID_TOKEN=1"), "/x?ID_TOKEN=-");
});
