import assert from "node:assert/strict";
import {before,after,test} from "node:test";
import {PrismaClient} from "@prisma/client";
import {createServer} from "vite";
import {isolatedPostgresUrl} from "./helpers/isolated-pg-guard.mjs";
const db=new PrismaClient({datasources:{db:{url:isolatedPostgresUrl()}}});
let vite,route,shop,previewCalls=0,previewHook,onConflict,UpstreamError,oldFetch;
const preview=()=>({locationName:"Synthetic",currency:"JPY",total:10,netSales:10,tax:0,discounts:0,vipPointsUsed:0,refundTotal:0,orderCount:1,refundCount:0,itemCount:1,voucherChangeAmount:0,paymentSections:[],pendingSpecialRefundOrderLabels:[]});
before(async()=>{
 oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('No external network in route acceptance');};
 shop=await db.shop.create({data:{shopifyShopGid:"gid://shopify/Shop/777",shopDomain:"synthetic-receipt.myshopify.com"}});
 const observed=new Proxy(db,{get(target,key){
  if(key==="settlementOperationLock")return{deleteMany:args=>db.settlementOperationLock.deleteMany(args),create:async args=>{try{return await db.settlementOperationLock.create(args);}catch(e){if(e.code==="P2002")onConflict?.();throw e;}}};
  const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
 }});
 globalThis.receiptRouteAcceptance={db:observed,auth:async()=>({shop,admin:{},corsJson:(body,init)=>Response.json(body,init)}),preview:async()=>{previewCalls++;return previewHook?previewHook():preview();}};
 vite=await createServer({configFile:false,appType:"custom",server:{middlewareMode:true,hmr:false},plugins:[{name:"synthetic-auth-and-preview-real-route-pg",enforce:"pre",resolveId(id){
  if(id==="../db.server")return "\0receipt-pg";
  if(id==="../utils/posAuth.server")return "\0receipt-auth";
  if(id==="../services/settlementEngine.server")return "\0receipt-preview";
  if(id==="../services/salesSummaryEngine.server")return "\0receipt-cache";
 },load(id){
  if(id==="\0receipt-pg")return "export default globalThis.receiptRouteAcceptance.db;";
  if(id==="\0receipt-auth")return "export const authenticatePosRequestOrCorsError=globalThis.receiptRouteAcceptance.auth;export const corsErrorJson=(_req,body,status)=>Response.json(body,{status});export const corsPreflightResponse=()=>new Response(null,{status:204});";
  if(id==="\0receipt-preview")return "export const buildSettlementPreview=globalThis.receiptRouteAcceptance.preview;";
  if(id==="\0receipt-cache")return "export const upsertDailySummaryCacheFromPreview=async()=>{};";
 }}]});
 route=await vite.ssrLoadModule("/app/routes/api.settlements.create.tsx");
 UpstreamError=(await vite.ssrLoadModule("/app/services/settlementUpstreamPage.server.ts")).UpstreamAggregationError;
});
after(async()=>{await vite?.close();await db.$disconnect();delete globalThis.receiptRouteAcceptance;globalThis.fetch=oldFetch;});
const request=date=>new Request("https://synthetic.invalid/api/settlements/create",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({locationId:"1",locationName:"Synthetic",targetDate:date})});
test("actual create route serializes two requests and returns one durable confirmed settlement",async()=>{
 let enter,release,conflict;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),observed=new Promise(r=>conflict=r);
 previewHook=async()=>{enter();await gate;return preview();};onConflict=()=>conflict();
 const first=route.action({request:request("2026-11-24")});let second;
 try{
  await entered;second=route.action({request:request("2026-11-24")});
  await Promise.race([observed,new Promise((_,reject)=>setTimeout(()=>reject(new Error("No real PG lock conflict")),5000))]);
  release();const [a,b]=await Promise.all([first,second]);assert.equal(a.status,201);assert.equal(b.status,200);
  const [av,bv]=await Promise.all([a.json(),b.json()]);assert.equal(av.settlementId,bv.settlementId);assert.equal(bv.idempotent,true);assert.equal(bv.confirmed,true);
  assert.equal(previewCalls,1);assert.equal(await db.settlement.count({where:{shopId:shop.id,targetDate:"2026-11-24"}}),1);assert.equal(await db.settlementOperationLock.count(),0);
 }finally{release();onConflict=null;previewHook=null;await Promise.allSettled([first,second]);}
});
test("upstream-incomplete response creates no settlement, releases lock and admits an explicit retry",async()=>{
 previewHook=async()=>{throw new UpstreamError();};
 const failed=await route.action({request:request("2026-11-25")});assert.equal(failed.status,500);assert.equal((await failed.json()).code,"UPSTREAM_INCOMPLETE");
 assert.equal(await db.settlement.count({where:{shopId:shop.id,targetDate:"2026-11-25"}}),0);assert.equal(await db.settlementOperationLock.count(),0);
 previewHook=null;const retry=await route.action({request:request("2026-11-25")});assert.equal(retry.status,201);
 assert.equal(await db.settlement.count({where:{shopId:shop.id,targetDate:"2026-11-25"}}),1);assert.equal(await db.settlementOperationLock.count(),0);
});
