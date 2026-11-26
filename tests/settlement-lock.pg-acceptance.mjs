import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createServer } from "vite";
import { isolatedPostgresUrl } from "./helpers/isolated-pg-guard.mjs";
const db = new PrismaClient({ datasources: { db: { url: isolatedPostgresUrl() } } });
let vite, withLock, onConflict;
const prefix = "synthetic-settlement-lock:";
before(async () => {
  globalThis.receiptSettlementTestDb = { settlementOperationLock: {
    deleteMany: args => db.settlementOperationLock.deleteMany(args),
    create: async args => { try { return await db.settlementOperationLock.create(args); } catch(error) { if(error.code === "P2002") onConflict?.(); throw error; } },
  } };
  vite = await createServer({configFile:false,appType:"custom",server:{middlewareMode:true,hmr:false},plugins:[{
    name:"real-postgres-lock-observer",enforce:"pre",
    resolveId(id) { if(id === "../db.server") return "\0actual-pg-lock-observer"; },
    load(id) { if(id === "\0actual-pg-lock-observer") return "export default globalThis.receiptSettlementTestDb;"; },
  }]});
  withLock = (await vite.ssrLoadModule("/app/services/settlementLock.server.ts")).withSettlementOperationLock;
});
after(async()=>{ await db.settlementOperationLock.deleteMany({where:{lockKey:{startsWith:prefix}}});await vite?.close();await db.$disconnect();delete globalThis.receiptSettlementTestDb; });
test("actual PostgreSQL unique conflict serializes callbacks and releases the settlement lock",async()=>{
  const key=prefix+"same",order=[];
  let enteredResolve,releaseResolve,conflictResolve;
  const entered=new Promise(r=>{enteredResolve=r}),release=new Promise(r=>{releaseResolve=r}),conflict=new Promise(r=>{conflictResolve=r});
  onConflict=()=>conflictResolve();
  const first=withLock(key,async()=>{order.push("a-start");enteredResolve();await release;order.push("a-end");});
  let second;
  try{
    await entered;second=withLock(key,async()=>{order.push("b-start");});
    await Promise.race([conflict,new Promise((_,reject)=>setTimeout(()=>reject(new Error("No real PG unique conflict observed")),5000))]);
    assert.deepEqual(order,["a-start"]);releaseResolve();await Promise.all([first,second]);
    assert.deepEqual(order,["a-start","a-end","b-start"]);assert.equal(await db.settlementOperationLock.count({where:{lockKey:key}}),0);
  }finally{releaseResolve();onConflict=null;await Promise.allSettled([first,second]);}
});
test("callback failure releases the real database lock and a later operation can enter",async()=>{
  const key=prefix+"throw";
  await assert.rejects(withLock(key,async()=>{throw new Error("synthetic callback failure");}),/synthetic callback failure/);
  assert.equal(await db.settlementOperationLock.count({where:{lockKey:key}}),0);
  assert.equal(await withLock(key,async()=>"recovered"),"recovered");
});
test("30-second deadline rejects after a real lock conflict without deleting another operation's lock",async()=>{
  const key=prefix+"deadline",originalNow=Date.now;let offset=0,ran=false;
  await db.settlementOperationLock.create({data:{lockKey:key,expiresAt:new Date("2099-01-01")}});
  Date.now=()=>originalNow()+offset;onConflict=()=>{offset=31000;};
  try{
    await assert.rejects(withLock(key,async()=>{ran=true;}),/精算処理が混み合っています/);
    assert.equal(ran,false);assert.equal(await db.settlementOperationLock.count({where:{lockKey:key}}),1);
  }finally{Date.now=originalNow;onConflict=null;await db.settlementOperationLock.deleteMany({where:{lockKey:key}});}
});
