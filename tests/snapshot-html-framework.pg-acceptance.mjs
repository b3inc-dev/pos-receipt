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

test("RECEIPT-SNAPSHOT-HTML-FRAMEWORK-PG-001: saved receipt snapshot and current output settings connect through real compiled HTML route without rewriting issued data", { timeout: 60000 }, async () => {
  const [a,b]=tenants;
  const headers=(f)=>({authorization:"Bearer "+normalToken(f),origin:"https://synthetic-pos.invalid",
    "user-agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"});
  const id="synthetic-issue-0325-a";
  const html=(paper)=>`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'"/></head><body><p>SAVED-${paper}-AMOUNT-100</p></body></html>`;
  const snapshot=JSON.stringify({format:"receipt-print-snapshot-v1",formVersion:"receipt-v1",locationName:"synthetic-original",templateData:{companyName:"SAVED-COMPANY"},renderedHtmlByPaperWidth:{58:html(58),80:html(80)}});
  await db.receiptIssue.update({where:{id},data:{printSnapshotJson:snapshot}});
  const corruptId="synthetic-corrupt-0528";
  await db.receiptIssue.create({data:{id:corruptId,shopId:a.id,orderId:"528",locationId:"gid://shopify/Location/325",amount:100,currency:"JPY",printSnapshotJson:"not-readable"}});
  const setting=(key,value)=>db.appSetting.upsert({where:{shopId_key:{shopId:a.id,key}},create:{shopId:a.id,key,valueJson:JSON.stringify(value)},update:{valueJson:JSON.stringify(value)}});
  const get=(f,issue=id)=>fetch(base+"/api/print/receipt/"+issue,{headers:headers(f)});
  const rows=()=>db.receiptIssue.findMany({where:{shopId:{in:tenants.map(f=>f.id)}},orderBy:{id:"asc"}});
  const beforeRows=await rows();
  await setting("print_settings",{paperWidthMm:58,receiptPrinterProfile:"standard"});
  const first=await get(a); assert.equal(first.status,200); assert.match(first.headers.get("content-type"),/text\/html/);
  assert.match(first.headers.get("content-security-policy"),/script-src 'none'/);
  assert.equal(await first.text(),html(58));
  assert.equal(await db.printRecord.count({where:{shopId:a.id}}),0,"Fetching a src HTML is not proof that POS accepted printing");
  await db.receiptTemplate.create({data:{shopId:a.id,name:"synthetic-current",isActive:true,templateJson:JSON.stringify({companyName:"CURRENT-MUST-NOT-REPLACE-SNAPSHOT"})}});
  assert.equal(await (await get(a)).text(),html(58),"Current template must not regenerate saved issue HTML");
  await setting("print_settings",{paperWidthMm:58,receiptPrinterProfile:"mcp31lb_58"});
  const corrected=await (await get(a)).text(); assert.match(corrected,/data-receipt-printer-profile="mcp31lb_58"/);assert.match(corrected,/SAVED-58-AMOUNT-100/);assert.doesNotMatch(corrected,/SAVED-80/);
  await setting("print_settings",{paperWidthMm:80,receiptPrinterProfile:"mcp31lb_58"});
  assert.equal(await (await get(a)).text(),html(80),"80mm uses saved 80mm HTML without 58mm correction");
  await setting("print_marks_v1",{receiptReprint:true,reprintText:"SYNTHETIC-REPRINT"});
  assert.doesNotMatch(await (await get(a)).text(),/SYNTHETIC-REPRINT/);
  const mark=await fetch(base+"/api/print/printed",{method:"POST",headers:{...headers(a),"content-type":"application/json"},body:JSON.stringify({kind:"receipt",id})});assert.equal(mark.status,200);
  const reprint=await(await get(a)).text();assert.match(reprint,/SYNTHETIC-REPRINT/);assert.match(reprint,/SAVED-80-AMOUNT-100/);
  assert.equal((await get(b)).status,404);
  const corrupt=await get(a,corruptId);assert.equal(corrupt.status,409);assert.doesNotMatch(await corrupt.text(),/CURRENT-MUST|SAVED-/);
  assert.deepEqual(await rows(),beforeRows,"Rendering, correction, reprint mark and unreadable snapshot rejection never rewrite issued amount/snapshot");
  assert.equal(await db.printRecord.count({where:{shopId:a.id}}),1);assert.equal(await db.printRecord.count({where:{shopId:b.id}}),0);
  assert.equal(await db.settlement.count({where:{shopId:{in:tenants.map(f=>f.id)}}}),0);
  assert.deepEqual(operations,[],"Seeded own fixture Shops resolve locally; no external reads or writes");
  console.log("RECEIPT_SNAPSHOT_HTML_FRAMEWORK_PG_ACCEPTED=1; physical_printer=not_tested; printing_api=not_tested");
});
