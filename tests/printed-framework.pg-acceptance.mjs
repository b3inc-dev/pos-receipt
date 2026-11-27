import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createHmac } from "node:crypto";
import { createServer as createPortServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import "@shopify/shopify-api/adapters/node";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import { isolatedPostgresUrl } from "./helpers/isolated-pg-guard.mjs";

const db = new PrismaClient({ datasources: { db: { url: isolatedPostgresUrl() } } });
const KEY = "0123456789abcdef0123456789abcdef", SECRET = "synthetic-print-record-0325";
const tenants = ["a", "b"].map((kind) => ({ kind, id: "print-record-0325-" + kind,
  shop: `print-record-${kind}-0325.myshopify.com`, token: "synthetic-print-record-" + kind }));
const envKeys = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SCOPES", "APP_DISTRIBUTION", "CUSTOM_APP_STORE_IDS", "SALES_SUMMARY_WEBHOOK_QUEUE", "SALES_SUMMARY_FILL_QUEUE"];
const previous = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
let child, base, oldFetch; const operations = [];

// Reuse the existing valid own-fixture POS token format. No additional signature/input exploration.
function normalToken(f) {
  const now = Math.floor(Date.now() / 1000), enc = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc({ iss: "https://" + f.shop + "/admin", dest: "https://" + f.shop, aud: KEY, sub: "325",
    exp: now + 300, nbf: now - 1, iat: now, jti: "synthetic-print-record-0325", sid: "synthetic-pos-session" });
  return h + "." + p + "." + createHmac("sha256", SECRET).update(h + "." + p).digest("base64url");
}
async function dropFailure() {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS print_record_0325_failure ON "PrintRecord"');
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS print_record_0325_failure()');
}
before(async () => {
  Object.assign(process.env, { SHOPIFY_API_KEY: KEY, SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: "https://synthetic-app.invalid",
    SCOPES: "read_orders,read_locations", APP_DISTRIBUTION: "public", CUSTOM_APP_STORE_IDS: "", SALES_SUMMARY_WEBHOOK_QUEUE: "0", SALES_SUMMARY_FILL_QUEUE: "0" });
  oldFetch = globalThis.fetch;
  for (const [i, f] of tenants.entries()) {
    await db.session.create({ data: { id: "offline_" + f.shop, shop: f.shop, state: "synthetic", isOnline: false,
      scope: process.env.SCOPES, accessToken: f.token, expires: new Date(Date.now() + 86400000),
      refreshToken: "synthetic-unused-refresh", refreshTokenExpires: new Date(Date.now() + 172800000) } });
    await db.shop.create({ data: { id: f.id, shopifyShopGid: "gid://shopify/Shop/325" + i, shopDomain: f.shop, planCode: "pro" } });
    await db.receiptIssue.create({ data: { id: "synthetic-issue-0325-" + f.kind, shopId: f.id, orderId: "325",
      locationId: "gid://shopify/Location/325", amount: 100 + i, currency: "JPY" } });
  }
  const portServer = createPortServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  base = "http://127.0.0.1:" + port;
  child = spawn(process.execPath, ["--import", "./tests/fixtures/printed-framework-transport.mjs", "server.js"], {
    env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
      SHOPIFY_APP_URL: base, RECEIPT_FRAMEWORK_FIXTURES: JSON.stringify(tenants) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.resume(); child.stderr.resume();
  child.on("message", (m) => operations.push(m));
  let ready = false;
  for (let n = 0; n < 160; n++) {
    assert.equal(child.exitCode, null, "Existing production server must remain running without a guard bypass");
    try { const r = await oldFetch(base + "/api/print/printed", { method: "OPTIONS", headers: { Origin: "https://synthetic-pos.invalid" } });
      if (r.status === 204) { assert.equal(r.headers.get("access-control-allow-origin"), "https://synthetic-pos.invalid"); ready = true; break; }
    } catch { /* bounded startup polling against loopback only */ }
    await delay(100);
  }
  assert.equal(ready, true, "Actual server.js/compiled ReactRouter must start within the finite window");
  assert.equal((await oldFetch(base + "/api/print/printed")).status, 405, "Actual route loader is reached through the compiled framework");
});
after(async () => { try { await dropFailure(); await db.shop.deleteMany({ where: { id: { in: tenants.map((f) => f.id) } } });
    await db.session.deleteMany({ where: { shop: { in: tenants.map((f) => f.shop) } } }); }
  finally { if (child && child.exitCode === null) {
      const ended = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM");
      await Promise.race([ended, delay(3000)]); if (child.exitCode === null) child.kill("SIGKILL");
    }
    await db.$disconnect();
    globalThis.fetch = oldFetch; setAbstractFetchFunc(oldFetch);
    for (const k of envKeys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } } });

test("RECEIPT-PRINTED-FRAMEWORK-PG-001: existing production server.js and compiled ReactRouter persist printed marks through normal SDK/PG and preserve failure recovery", { timeout: 60000 }, async () => {
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
  assert.ok(operations.length > 0); assert.ok(operations.every((c) => c.type === "read" && c.operation === "ShopPlan"));
  console.log("RECEIPT_PRINTED_FRAMEWORK_PG_ACCEPTED=1");
});
