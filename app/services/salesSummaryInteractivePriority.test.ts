import assert from "node:assert/strict";
import {test} from "node:test";
import {runSettlementGraphqlSerial,runAsSettlementBackground} from "../lib/shopifyGraphqlThrottle.server";
import {runBackgroundDailySlices} from "./salesSummaryBackgroundSlice.server";
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test("実際の背景スライスは画面の後で実行され、再計算自体は1件も省略しない",async()=>{
 let release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);const order:string[]=[];
 const running=runAsSettlementBackground(()=>runSettlementGraphqlSerial("context-test",async()=>{order.push("running");await blocked;}));
 await tick();
 const background=runBackgroundDailySlices([{label:"refund refresh",run:()=>runSettlementGraphqlSerial("context-test",async()=>{order.push("refund refresh");})}]);
 const foreground=runSettlementGraphqlSerial("context-test",async()=>{order.push("screen");return 10;});
 release();await running;assert.equal(await foreground,10);assert.deepEqual(order,["running","screen"]);
 assert.deepEqual(await background,{errors:[]});assert.deepEqual(order,["running","screen","refund refresh"]);
});

for (const join of ["share", "lookup"] as const) {
 test(`画面の${join}で相乗りした背景集計は後着の画面より先へ昇格する`,async()=>{
  const {shareInFlight,getInFlight}=await import("../utils/salesSummaryLoadShare.server");
  const {promoteSettlementBackground}=await import("../lib/shopifyGraphqlThrottle.server");
  const shop=`promote-${join}`;const key=`loc|${shop}|1|2026-11-24`;const priority={background:true};
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const order:string[]=[];
  const running=runSettlementGraphqlSerial(shop,async()=>{await gate;});await tick();
  let computes=0;
  const background=shareInFlight(key,()=>runAsSettlementBackground(()=>runSettlementGraphqlSerial(shop,async()=>{computes++;order.push("shared");return 99;}),priority),{background:true,onForegroundJoin:()=>promoteSettlementBackground(priority)});
  const reader=join==="share" ? shareInFlight(key,async()=>{throw Error("duplicate compute");}) : getInFlight(key);
  const later=runSettlementGraphqlSerial(shop,async()=>order.push("later screen"));
  release();await running;assert.equal(await reader,99);await background;await later;
  assert.deepEqual(order,["shared","later screen"]);assert.equal(computes,1);assert.equal(getInFlight(key),null);
 });
}
