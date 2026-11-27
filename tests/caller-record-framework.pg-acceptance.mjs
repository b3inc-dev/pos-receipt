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

test("RECEIPT-CALLER-RECORD-0600: existing extension caller connects accepted outcomes to real framework/PG records without asserting native or paper completion", { timeout: 60000 }, async () => {
  const {printGiftReceipt,PRINT_OUTCOME}=await import("../extensions/common/printApi.js");
  const a=tenants[0], id="synthetic-issue-0325-a";
  const oldShopify=globalThis.shopify,oldWindow=globalThis.window,clientFetch=globalThis.fetch;
  const printer={id:"synthetic-owned-printer",connected:true,name:"fixture"};
  const html='<!DOCTYPE html><html><head></head><body>OWNED-CALLER-0600</body></html>';
  await db.receiptIssue.update({where:{id},data:{printSnapshotJson:JSON.stringify({format:"receipt-print-snapshot-v1",formVersion:"receipt-v1",locationName:"synthetic",templateData:{},renderedHtmlByPaperWidth:{58:html,80:html}})}});
  const issueBefore=await db.receiptIssue.findUnique({where:{id}});
  const record=()=>db.printRecord.findUnique({where:{shopId_kind_targetId:{shopId:a.id,kind:"receipt",targetId:id}}});
  let mode="direct", printRequests=0, documentReads=0, recordPosts=0;
  try {
    globalThis.window={location:{origin:base}}; // Existing getAppUrl development-origin branch, product source unchanged.
    globalThis.fetch=async(url,init)=>{
      const target=new URL(String(url));assert.equal(target.origin,base);assert.equal(target.pathname,"/api/print/printed");
      assert.equal(init.method,"POST");assert.deepEqual(JSON.parse(init.body),{kind:"receipt",id});recordPosts++;
      return oldFetch(url,init);
    };
    globalThis.shopify={session:{getSessionToken:async()=>normalToken(a)},printing:{
      getPrinters:async()=>mode==="dialog"?[]:[printer],
      print:async(src,options)=>{
        printRequests++;assert.equal(src,"/api/print/receipt/"+id);
        if(mode==="dialog")assert.equal(options,undefined);else assert.equal(options.printer,printer);
        // Owned host contract substitute only: not the native Shopify Printing API.
        const response=await oldFetch(base+src,{headers:{authorization:"Bearer "+normalToken(a),origin:"https://synthetic-pos.invalid","user-agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"}});
        documentReads++;assert.equal(response.status,200);assert.equal(await response.text(),html);
        if(mode==="failed")throw new Error("synthetic printer refusal");
      },
    }};
    const direct=await printGiftReceipt(id);assert.equal(direct.outcome,PRINT_OUTCOME.DIRECT_ACCEPTED);assert.equal(direct.ok,true);assert.equal(direct.paperConfirmed,false);
    assert.equal((await record()).printCount,1);assert.equal(recordPosts,1);
    mode="dialog";
    const dialog=await printGiftReceipt(id,{allowDialog:true});assert.equal(dialog.outcome,PRINT_OUTCOME.DIALOG_PRESENTED);assert.equal(dialog.ok,true);assert.equal(dialog.paperConfirmed,false);
    assert.equal((await record()).printCount,2,"Existing accepted-dialog contract records API acceptance, never paper completion");assert.equal(recordPosts,2);
    const beforeFailure=await record();mode="failed";
    const failed=await printGiftReceipt(id);assert.equal(failed.outcome,PRINT_OUTCOME.FAILED);assert.equal(failed.ok,false);assert.equal(failed.paperConfirmed,false);
    assert.deepEqual(await record(),beforeFailure);assert.equal(recordPosts,2);assert.equal(printRequests,3);assert.equal(documentReads,3);
    assert.deepEqual(await db.receiptIssue.findUnique({where:{id}}),issueBefore);
    assert.equal(await db.settlement.count({where:{shopId:{in:tenants.map(f=>f.id)}}}),0);
    assert.deepEqual(operations,[],"Seeded fixture Shops need no external reads/writes");
    console.log("RECEIPT_CALLER_RECORD_CONTRACT_ACCEPTED=1; native_printing_api=not_executed; physical_paper=not_tested; dialog_acceptance_is_not_a_defect");
  }finally{
    globalThis.fetch=clientFetch;
    if(oldShopify===undefined)delete globalThis.shopify;else globalThis.shopify=oldShopify;
    if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;
  }
});
