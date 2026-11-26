import assert from "node:assert/strict";import{before,after,test}from"node:test";import{createServer}from"vite";
let vite,engine,oldFetch,UpstreamError;
before(async()=>{
 oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("No external network in engine stream acceptance");};
 vite=await createServer({configFile:false,appType:"custom",server:{middlewareMode:true,hmr:false},plugins:[{name:"test-only-engine-private-stream-exposure",enforce:"pre",transform(code,id){if(id.endsWith("/app/services/settlementEngine.server.ts"))return code+"\nexport {fetchAllOrders as testFetchOrders,fetchOrdersUpdatedInDayRange as testFetchRefunds};\n";}}]});
 engine=await vite.ssrLoadModule("/app/services/settlementEngine.server.ts");UpstreamError=(await vite.ssrLoadModule("/app/services/settlementUpstreamPage.server.ts")).UpstreamAggregationError;
});
after(async()=>{await vite?.close();globalThis.fetch=oldFetch;});
const row=(id,tags=[])=>({id,tags,transactions:[],refunds:[{id:"refund-"+id,transactions:{nodes:[{id:"tx-"+id,kind:"REFUND"}]},refundLineItems:{nodes:[]}}]});
const page=(nodes,next=null)=>({data:{orders:{nodes,pageInfo:{hasNextPage:Boolean(next),endCursor:next}}}});
function admin(pages){let i=0;const calls=[];return{calls,graphql:async(query,args)=>{calls.push({query,variables:args.variables});if(i>=pages.length)throw new Error("Unexpected read after terminal page");return Response.json(pages[i++]);}};}
test("RECEIPT-ENGINE-STREAM-001: both actual engine loops join pages, exclude settlement tags and normalize refund transactions",async()=>{
 for(const fn of[engine.testFetchOrders,engine.testFetchRefunds]){
  const client=admin([page([row("a"),row("settlement",["SeTtLeMeNt"])],"A"),page([row("b")])]);
  const rows=await fn(client,"synthetic-filter");assert.deepEqual(rows.map(r=>r.id),["a","b"]);assert.deepEqual(client.calls.map(c=>c.variables.after),[null,"A"]);assert.ok(client.calls.every(c=>c.variables.first===100&&c.variables.query==="synthetic-filter"));assert.equal(rows[1].refunds[0].transactions[0].id,"tx-b");
 }
});
test("both actual engine loops reject a missing later page instead of returning their first-page partial orders",async()=>{
 for(const fn of[engine.testFetchOrders,engine.testFetchRefunds]){const client=admin([page([row("a")],"A"),{data:{orders:null}}]);await assert.rejects(fn(client,"synthetic-filter"),e=>e instanceof UpstreamError);assert.equal(client.calls.length,2);}
});
test("both actual engine loops stop nonterminal cursor cycles before requesting a third page",async()=>{
 for(const fn of[engine.testFetchOrders,engine.testFetchRefunds]){const client=admin([page([row("a")],"A"),page([row("b")],"A")]);await assert.rejects(fn(client,"synthetic-filter"),e=>e instanceof UpstreamError);assert.equal(client.calls.length,2);}
});
