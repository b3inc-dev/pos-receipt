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
