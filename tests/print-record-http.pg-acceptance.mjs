import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createHmac } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createServer as createViteServer } from "vite";
import "@shopify/shopify-api/adapters/node";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import { isolatedPostgresUrl } from "./helpers/isolated-pg-guard.mjs";

const db = new PrismaClient({ datasources: { db: { url: isolatedPostgresUrl() } } });
const KEY = "0123456789abcdef0123456789abcdef", SECRET = "synthetic-print-record-0325";
const tenants = ["a", "b"].map((kind) => ({ kind, id: "print-record-0325-" + kind,
  shop: `print-record-${kind}-0325.myshopify.com`, token: "synthetic-print-record-" + kind }));
const envKeys = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SCOPES", "APP_DISTRIBUTION", "CUSTOM_APP_STORE_IDS", "SALES_SUMMARY_WEBHOOK_QUEUE", "SALES_SUMMARY_FILL_QUEUE"];
const previous = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
let vite, route, http, base, oldFetch; const operations = [];

// Reuse the existing valid own-fixture POS token format. No additional signature/input exploration.
function normalToken(f) {
  const now = Math.floor(Date.now() / 1000), enc = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc({ iss: "https://" + f.shop + "/admin", dest: "https://" + f.shop, aud: KEY, sub: "325",
    exp: now + 300, nbf: now - 1, iat: now, jti: "synthetic-print-record-0325", sid: "synthetic-pos-session" });
  return h + "." + p + "." + createHmac("sha256", SECRET).update(h + "." + p).digest("base64url");
}
async function isolatedFetch(input, init) {
  const req = new Request(input, init), url = new URL(req.url);
  if (base && url.origin === base) {
    assert.equal(url.pathname, "/api/print/printed"); assert.equal(req.method, "POST"); return oldFetch(req);
  }
  const f = tenants.find((x) => x.shop === url.hostname);
  assert.ok(f, "Only exact own synthetic tenants may be contacted");
  assert.equal(url.pathname, "/admin/api/2026-04/graphql.json"); assert.equal(req.method, "POST");
  assert.equal(req.headers.get("x-shopify-access-token"), f.token);
  const wire = JSON.parse(await req.text()); assert.doesNotMatch(wire.query, /\bmutation\b/i);
  assert.match(wire.query, /query ShopPlan/); operations.push({ tenant: f.kind, operation: "ShopPlan" });
  return Response.json({ data: { shop: { plan: { partnerDevelopment: false } } } }, { headers: { "x-shopify-api-version": "2026-04" } });
}
async function dropFailure() {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS print_record_0325_failure ON "PrintRecord"');
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS print_record_0325_failure()');
}
before(async () => {
  Object.assign(process.env, { SHOPIFY_API_KEY: KEY, SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: "https://synthetic-app.invalid",
    SCOPES: "read_orders,read_locations", APP_DISTRIBUTION: "public", CUSTOM_APP_STORE_IDS: "", SALES_SUMMARY_WEBHOOK_QUEUE: "0", SALES_SUMMARY_FILL_QUEUE: "0" });
  globalThis.prismaGlobal = db; oldFetch = globalThis.fetch; globalThis.fetch = isolatedFetch; setAbstractFetchFunc(isolatedFetch);
  for (const [i, f] of tenants.entries()) {
    await db.session.create({ data: { id: "offline_" + f.shop, shop: f.shop, state: "synthetic", isOnline: false,
      scope: process.env.SCOPES, accessToken: f.token, expires: new Date(Date.now() + 86400000),
      refreshToken: "synthetic-unused-refresh", refreshTokenExpires: new Date(Date.now() + 172800000) } });
    await db.shop.create({ data: { id: f.id, shopifyShopGid: "gid://shopify/Shop/325" + i, shopDomain: f.shop, planCode: "pro" } });
    await db.receiptIssue.create({ data: { id: "synthetic-issue-0325-" + f.kind, shopId: f.id, orderId: "325",
      locationId: "gid://shopify/Location/325", amount: 100 + i, currency: "JPY" } });
  }
  vite = await createViteServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false } });
  route = await vite.ssrLoadModule("/app/routes/api.print.printed.tsx"); setAbstractFetchFunc(isolatedFetch);
  http = createHttpServer(async (req, res) => { try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    const request = new Request(base + req.url, { method: req.method, headers, body: Buffer.concat(chunks) });
    const response = await route.action({ request });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end("synthetic adapter failed"); } });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve)); base = "http://127.0.0.1:" + http.address().port;
});
after(async () => { try { await dropFailure(); await db.shop.deleteMany({ where: { id: { in: tenants.map((f) => f.id) } } });
    await db.session.deleteMany({ where: { shop: { in: tenants.map((f) => f.shop) } } }); }
  finally { http?.closeAllConnections(); if (http) await new Promise((resolve) => http.close(resolve)); await vite?.close(); await db.$disconnect();
    delete globalThis.prismaGlobal; globalThis.fetch = oldFetch; setAbstractFetchFunc(oldFetch);
    for (const k of envKeys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } } });

test("RECEIPT-PRINT-RECORD-HTTP-PG-001: accepted-print mark reaches actual HTTP/normal SDK/PG, separates kind and tenant, and retries only a failed durable write", { timeout: 30000 }, async () => {
  const [a, b] = tenants;
  const post = (f, kind, id) => fetch(base + "/api/print/printed", { method: "POST", headers: {
    authorization: "Bearer " + normalToken(f), "content-type": "application/json", origin: "https://synthetic-pos.invalid",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36" }, body: JSON.stringify({ kind, id }) });
  const rows = () => db.printRecord.findMany({ where: { shopId: { in: tenants.map((f) => f.id) } }, orderBy: [{ shopId: "asc" }, { kind: "asc" }, { targetId: "asc" }] });
  const issuesBefore = await db.receiptIssue.findMany({ where: { shopId: { in: tenants.map((f) => f.id) } }, orderBy: { id: "asc" } });
  const first = await post(a, "sales", "gid://shopify/Order/325"); assert.equal(first.status, 200); assert.equal((await first.json()).ok, true);
  assert.equal(first.headers.get("access-control-allow-origin"), "*", "Existing normal SDK success response uses wildcard CORS; no product CORS change");
  const firstRow = (await rows())[0]; assert.equal(firstRow.targetId, "325"); assert.equal(firstRow.printCount, 1);
  assert.equal((await post(a, "sales", "325")).status, 200);
  let aSales = (await rows()).find((r) => r.shopId === a.id && r.kind === "sales");
  assert.equal(aSales.id, firstRow.id); assert.equal(aSales.printCount, 2); assert.deepEqual(aSales.firstPrintedAt, firstRow.firstPrintedAt);
  assert.ok(aSales.lastPrintedAt >= firstRow.lastPrintedAt);
  assert.equal((await post(a, "gift", "325")).status, 200); assert.equal((await post(a, "receipt", "synthetic-issue-0325-a")).status, 200);
  const beforeOther = await rows(); assert.equal((await post(b, "receipt", "synthetic-issue-0325-a")).status, 404);
  assert.deepEqual(await rows(), beforeOther, "Unrelated receipt ownership denial must not persist a print mark");
  assert.equal((await post(b, "sales", "325")).status, 200);
  assert.deepEqual((await rows()).filter((r) => r.shopId === a.id), beforeOther);
  const beforeFailure = await rows();
  await db.$executeRawUnsafe(`CREATE FUNCTION print_record_0325_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."targetId" = 'retry-0325' THEN RAISE EXCEPTION 'synthetic print record failure'; END IF; RETURN NEW; END; $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER print_record_0325_failure BEFORE INSERT ON "PrintRecord" FOR EACH ROW EXECUTE FUNCTION print_record_0325_failure()');
  const failed = await post(a, "sales", "retry-0325"); assert.equal(failed.status, 500); assert.equal((await failed.json()).ok, false);
  assert.deepEqual(await rows(), beforeFailure, "Failed PG write must leave all selected synthetic PrintRecord rows unchanged");
  await dropFailure(); assert.equal((await post(a, "sales", "retry-0325")).status, 200);
  const finalRows = await rows(); assert.equal(finalRows.length, 5);
  assert.equal(finalRows.find((r) => r.targetId === "retry-0325").printCount, 1);
  assert.deepEqual(await db.receiptIssue.findMany({ where: { shopId: { in: tenants.map((f) => f.id) } }, orderBy: { id: "asc" } }), issuesBefore,
    "Print decoration records must not alter synthetic issued amounts or issue rows");
  assert.equal(await db.settlement.count({ where: { shopId: { in: tenants.map((f) => f.id) } } }), 0);
  assert.ok(operations.every((c) => c.operation === "ShopPlan"));
  console.log("RECEIPT_PRINT_RECORD_HTTP_PG_ACCEPTED=1");
});
