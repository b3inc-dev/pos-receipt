import assert from "node:assert/strict";
import {before,after,test} from "node:test";
import {createHmac} from "node:crypto";
import {createServer as createHttpServer} from "node:http";
import {PrismaClient} from "@prisma/client";
import {createServer as createViteServer} from "vite";
import "@shopify/shopify-api/adapters/node";
import {setAbstractFetchFunc} from "@shopify/shopify-api/runtime";
import {isolatedPostgresUrl} from "./helpers/isolated-pg-guard.mjs";

const db=new PrismaClient({datasources:{db:{url:isolatedPostgresUrl()}}});
const SHOP="pos-http-2323.myshopify.com",ID="pos-http-2323",LOC="gid://shopify/Location/2323",DAY="2026-11-26";
const KEY="0123456789abcdef0123456789abcdef",SECRET="synthetic-pos-secret",TOKEN="synthetic-pos-token",ORIGIN="https://synthetic-pos.invalid";
const envKeys=["SHOPIFY_API_KEY","SHOPIFY_API_SECRET","SHOPIFY_APP_URL","SCOPES","APP_DISTRIBUTION","CUSTOM_APP_STORE_IDS","SALES_SUMMARY_WEBHOOK_QUEUE","SALES_SUMMARY_FILL_QUEUE"];
const priorEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
let vite,route,http,base,originalFetch;const operations=[];
function jwt(secret=SECRET){
 const now=Math.floor(Date.now()/1000),enc=x=>Buffer.from(JSON.stringify(x)).toString("base64url");
 const head=enc({alg:"HS256",typ:"JWT"}),body=enc({iss:"https://"+SHOP+"/admin",dest:"https://"+SHOP,aud:KEY,sub:"2323",exp:now+300,nbf:now-1,iat:now,jti:"synthetic-2323",sid:"synthetic-pos-session"});
 return head+"."+body+"."+createHmac("sha256",secret).update(head+"."+body).digest("base64url");
}
async function isolatedFetch(input,init){
 const req=new Request(input,init),u=new URL(req.url);
 if(base&&u.origin===base){assert.ok(["GET","OPTIONS"].includes(req.method));return originalFetch(req);}
 assert.equal(u.hostname,SHOP,"Only exact synthetic SDK tenant permitted");assert.equal(u.pathname,"/admin/api/2026-04/graphql.json");
 assert.equal(req.method,"POST");assert.equal(req.headers.get("x-shopify-access-token"),TOKEN);
 const wire=JSON.parse(await req.text());assert.doesNotMatch(wire.query,/\bmutation\b/i);
 const name=wire.query.match(/\bquery\s+(\w+)/)?.[1];operations.push(name);
 assert.equal(name,"ShopPlan","Only plan read is needed for cached-only daily HTTP");
 return Response.json({data:{shop:{plan:{partnerDevelopment:false}}}},{headers:{"x-shopify-api-version":"2026-04"}});
}
before(async()=>{
 Object.assign(process.env,{SHOPIFY_API_KEY:KEY,SHOPIFY_API_SECRET:SECRET,SHOPIFY_APP_URL:"https://synthetic-app.invalid",SCOPES:"read_orders,read_locations",APP_DISTRIBUTION:"public",CUSTOM_APP_STORE_IDS:"",SALES_SUMMARY_WEBHOOK_QUEUE:"0",SALES_SUMMARY_FILL_QUEUE:"0"});
 globalThis.prismaGlobal=db;originalFetch=globalThis.fetch;globalThis.fetch=isolatedFetch;setAbstractFetchFunc(isolatedFetch);
 await db.session.create({data:{id:"offline_"+SHOP,shop:SHOP,state:"synthetic",isOnline:false,scope:process.env.SCOPES,accessToken:TOKEN,expires:new Date(Date.now()+86400000),refreshToken:"synthetic-refresh",refreshTokenExpires:new Date(Date.now()+172800000)}});
 await db.shop.create({data:{id:ID,shopifyShopGid:"gid://shopify/Shop/2323",shopDomain:SHOP,planCode:"pro"}});
 await db.location.create({data:{shopId:ID,shopifyLocationGid:LOC,name:"Synthetic",salesSummaryEnabled:true}});
 await db.salesSummaryCacheDaily.create({data:{shopId:ID,locationId:LOC,targetDate:DAY,actual:850,orders:1,items:2}});
 vite=await createViteServer({configFile:false,appType:"custom",server:{middlewareMode:true,hmr:false}});
 const settings=await vite.ssrLoadModule("/app/utils/appSettings.server.ts");
 await db.appSetting.createMany({data:[{shopId:ID,key:settings.SALES_SUMMARY_SETTINGS_KEY,valueJson:JSON.stringify({salesSummaryEnabled:true})},{shopId:ID,key:settings.GENERAL_SETTINGS_KEY,valueJson:JSON.stringify({defaultTimezone:"Asia/Tokyo"})}]});
 route=await vite.ssrLoadModule("/app/routes/api.sales-summary.daily.tsx");setAbstractFetchFunc(isolatedFetch);
 http=createHttpServer(async(req,res)=>{try{
  const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(","):v);
  const request=new Request(base+req.url,{method:req.method,headers});
  const response=await (req.method==="GET"?route.loader({request}):route.action({request}));
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end("synthetic adapter failed");}});
 await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));base="http://127.0.0.1:"+http.address().port;
});
after(async()=>{try{await db.shop.deleteMany({where:{id:ID}});await db.session.deleteMany({where:{shop:SHOP}});}
 finally{http?.closeAllConnections();if(http)await new Promise(resolve=>http.close(resolve));await vite?.close();await db.$disconnect();delete globalThis.prismaGlobal;globalThis.fetch=originalFetch;setAbstractFetchFunc(originalFetch);for(const k of envKeys){if(priorEnv[k]===undefined)delete process.env[k];else process.env[k]=priorEnv[k];}}});
test("RECEIPT-POS-HTTP-001: loopback HTTP reaches actual POS SDK JWT/offline PG/plan/daily cache, rejects tamper and Lite, preserves CORS",{timeout:30000},async()=>{
 const url=()=>base+"/api/sales-summary/daily?targetDate="+DAY+"&cachedOnly=1&locationIds%5B%5D=2323";
 const headers=token=>({Authorization:"Bearer "+token,Origin:ORIGIN,"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"});
 const before=await db.salesSummaryCacheDaily.findMany({where:{shopId:ID}});
 const preflight=await fetch(url(),{method:"OPTIONS",headers:{Origin:ORIGIN}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get("access-control-allow-origin"),ORIGIN);
 const bad=await fetch(url(),{headers:headers(jwt("wrong-synthetic-secret"))});assert.equal(bad.status,401);assert.equal(bad.headers.get("access-control-allow-origin"),ORIGIN);assert.equal(operations.length,0,"tampered JWT must stop before SDK Admin reads");
 const good=await fetch(url(),{headers:headers(jwt())});assert.equal(good.status,200);assert.ok(good.headers.get("access-control-allow-origin"));const payload=await good.json();
 assert.equal(payload.cacheComplete,true);assert.equal(payload.rows.length,1);assert.equal(payload.rows[0].locationId,LOC);assert.equal(payload.rows[0].actual,850);assert.equal(payload.totals.actual,850);
 await db.shop.update({where:{id:ID},data:{planCode:"lite"}});
 const lite=await fetch(url(),{headers:headers(jwt())});assert.equal(lite.status,403);assert.ok(lite.headers.get("access-control-allow-origin"));assert.equal((await lite.json()).ok,false);
 assert.deepEqual(operations,["ShopPlan","ShopPlan"]);assert.deepEqual(await db.salesSummaryCacheDaily.findMany({where:{shopId:ID}}),before,"HTTP cache read/denials must not change persisted summary");
});
