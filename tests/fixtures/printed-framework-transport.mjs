import assert from "node:assert/strict";
import "@shopify/shopify-api/adapters/node";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
const fixtures = JSON.parse(process.env.RECEIPT_FRAMEWORK_FIXTURES);
async function transport(input, init) {
  const req = new Request(input, init), url = new URL(req.url);
  const f = fixtures.find((x) => x.shop === url.hostname);
  if (!f) { process.send?.({ type: "denied-unexpected-network" }); throw new Error("Unexpected external request denied"); }
  assert.equal(url.protocol, "https:"); assert.equal(url.pathname, "/admin/api/2026-04/graphql.json");
  assert.equal(req.method, "POST"); assert.equal(req.headers.get("x-shopify-access-token"), f.token);
  const wire = JSON.parse(await req.text()); assert.doesNotMatch(wire.query, /\bmutation\b/i);
  assert.match(wire.query, /query ShopPlan/);
  process.send?.({ type: "read", operation: "ShopPlan", tenant: f.kind });
  return Response.json({ data: { shop: { plan: { partnerDevelopment: false } } } }, { headers: { "x-shopify-api-version": "2026-04" } });
}
globalThis.fetch = transport; setAbstractFetchFunc(transport);
