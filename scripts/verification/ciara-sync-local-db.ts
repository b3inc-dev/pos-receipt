/** 手動検証専用。指定の使い捨てローカルDB以外では起動しない。外部APIは使わない。 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import PgBoss from "pg-boss";
const url = new URL(process.env.DATABASE_URL ?? "invalid:");
assert.equal(url.hostname,"127.0.0.1");assert.equal(url.port,"55439");assert.equal(url.pathname,"/pos_receipt_speed_test");
assert.equal(process.env.APP_DISTRIBUTION,"inhouse");
assert.ok(!process.env.CIARA_BUDGET_SYNC_SECRET,"外部接続用の鍵を渡さないでください");
const {default:db}=await import("../../app/db.server");
const shop=await db.shop.create({data:{shopDomain:`local-${Date.now()}.invalid`,shopifyShopGid:`gid://shopify/Shop/${Date.now()}`}});
mock.module("../../app/shopify.server",{namedExports:{authenticate:{admin:async()=>({session:{shop:shop.shopDomain},admin:{}})}}});
mock.module("../../app/utils/shopResolver.server",{namedExports:{resolveShop:async()=>shop}});
const budget=await import("../../app/routes/app.budget-sync");
const visits=await import("../../app/routes/app.footfall-sync");
const {createCiaraSyncScheduler}=await import("../../app/services/ciaraSyncScheduler.server");
const {patchSyncSettings}=await import("../../app/services/ciaraSyncSettingsPersistence.server");
const bosses:PgBoss[]=[];
try {
 for(const [key,route] of [["ciara_budget_sync",budget],["ciara_visit_sync",visits]] as const){
   for(const enabled of [true,false,true]){
     const form=new FormData();form.set("intent","save");form.set("enabled",String(enabled));
     const response=await route.action({request:new Request("https://local.invalid/app/test",{method:"POST",body:form}),params:{},context:{}});
     assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
     const loaded=await route.loader({request:new Request("https://local.invalid/app/test"),params:{},context:{}});
     assert.ok(!(loaded instanceof Response));assert.equal(loaded.settings.enabled,enabled);
   }
   await Promise.all([
     patchSyncSettings(db.appSetting,shop.id,key,{enabled:false,lastRun:null as unknown},{enabled:false}),
     patchSyncSettings(db.appSetting,shop.id,key,{enabled:false,lastRun:null as unknown},{lastRun:{ok:true,message:"local-db-result"}}),
   ]);
   const row=await db.appSetting.findUniqueOrThrow({where:{shopId_key:{shopId:shop.id,key}}});const saved=JSON.parse(row.valueJson);
   assert.equal(saved.enabled,false);assert.equal(saved.lastRun.message,"local-db-result");
 }
 console.log("PASS real PostgreSQL: 予算/入店数のON/OFF保存→loader再読込、並行結果保存でOFF維持");
 const jobs=[{queue:"verify-speed-budget",cron:"7 * * * *"},{queue:"verify-speed-visits",cron:"*/5 * * * *"}];
 await Promise.all(jobs.map(async({queue,cron})=>{
   let done!:()=>void;const completed=new Promise<void>(resolve=>done=resolve);
   const scheduler=createCiaraSyncScheduler({tag:queue,queue,cron,ready:()=>true,restartDelayMs:0,work:async()=>done(),
     createBoss:()=>{const boss=new PgBoss({connectionString:process.env.DATABASE_URL,application_name:queue,pollingIntervalSeconds:1});bosses.push(boss);return boss as never;}});
   const boss=await scheduler.ensure();assert.ok(boss);assert.equal(scheduler.status().state,"running");
   await (boss as unknown as PgBoss).send(queue,{});
   let timeout:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([completed,new Promise((_,reject)=>timeout=setTimeout(()=>reject(Error("worker timeout")),15000))]);}finally{clearTimeout(timeout);}
   console.log(`PASS real pg-boss: ${queue} queue/schedule/work作成と投入ジョブ実行`);
 }));
} finally {
 await Promise.all(bosses.map(boss=>boss.stop({timeout:5000})));
 await db.$disconnect();
}
