import assert from "node:assert/strict";
import { test } from "node:test";
import { createSettlementWorkQueue } from "./settlementWorkQueue.server";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return {promise,release}; }

test("画面の集計を先に実行し、同時実行を増やさず背景も8件ごとに進める", async () => {
 const q=createSettlementWorkQueue({graceMs:0});const first=gate();const order:string[]=[];let active=0;let maximum=0;
 const run=(label:string,blocked=false)=>async()=>{active++;maximum=Math.max(maximum,active);order.push(label);if(blocked)await first.promise;await tick();active--;return label;};
 const all=[q.run("s",true,run("running-bg",true))];await tick();
 for(let i=0;i<15;i++)all.push(q.run("s",true,run(`bg${i}`)));
 for(let i=0;i<15;i++)all.push(q.run("s",false,run(`screen${i}`)));
 first.release();await Promise.all(all);await tick();
 assert.equal(maximum,1);assert.deepEqual(order.slice(1,9),Array.from({length:8},(_,i)=>`screen${i}`));assert.equal(order[9],"bg0");
 assert.equal(order.indexOf("screen14"),16);assert.equal(q.size(),0);assert.equal(order.length,31);
});
test("前の失敗や同期throwで後続を巻き込まず、別ストアを止めない",async()=>{
 const q=createSettlementWorkQueue({graceMs:0});const first=gate();const order:string[]=[];
 const failed=q.run("s",true,async()=>{await first.promise;throw Error("first failed");});
 const reject=assert.rejects(failed,/first failed/);
 const second=q.run("s",false,async()=>{order.push("second");return 42;});
 assert.equal(await q.run("other",false,async()=>"independent"),"independent");first.release();await reject;assert.equal(await second,42);
 await assert.rejects(q.run("s",false,()=>{throw Error("sync throw");}),/sync throw/);assert.equal(await q.run("s",true,async()=>"recovered"),"recovered");
 await tick();assert.equal(q.size(),0);
});
test("店舗ごとに順に積む画面集計の合間を待ち、終われば状態を解放する",async()=>{
 const q=createSettlementWorkQueue({graceMs:25});const order:string[]=[];
 await q.run("s",false,async()=>order.push("screen1"));
 const bg=q.run("s",true,async()=>order.push("background"));
 await tick();assert.deepEqual(order,["screen1"]);
 await q.run("s",false,async()=>order.push("screen2"));
 await bg;assert.deepEqual(order,["screen1","screen2","background"]);await tick();assert.equal(q.size(),0);
});
