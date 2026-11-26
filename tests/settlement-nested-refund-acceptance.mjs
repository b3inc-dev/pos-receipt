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
test("RECEIPT-NESTED-REFUND-001: both actual loops reject explicitly incomplete refund transactions",async()=>{
 for(const fn of[engine.testFetchOrders,engine.testFetchRefunds]){const value=row("nested");value.refunds[0].transactions.pageInfo={hasNextPage:true};const client=admin([page([value])]);await assert.rejects(fn(client,"synthetic-filter"),e=>e instanceof UpstreamError,"incomplete refund connections must reject");assert.equal(client.calls.length,1);assert.match(client.calls[0].query,/transactions\(first: 50\)\s*\{\s*pageInfo\s*\{ hasNextPage \}/);}
});
test("actual orders loop rejects incomplete refund line items before publishing its partial order",async()=>{const value=row("line-items");value.refunds[0].refundLineItems.pageInfo={hasNextPage:true};const client=admin([page([value])]);await assert.rejects(engine.testFetchOrders(client,"synthetic-filter"),e=>e instanceof UpstreamError);assert.match(client.calls[0].query,/refundLineItems\(first: 250\)\s*\{\s*pageInfo\s*\{ hasNextPage \}/);});
test("complete nested connections remain valid without a new all-pages or TTL contract",async()=>{for(const fn of[engine.testFetchOrders,engine.testFetchRefunds]){const value=row("complete");value.refunds[0].transactions.pageInfo={hasNextPage:false};value.refunds[0].refundLineItems.pageInfo={hasNextPage:false};assert.equal((await fn(admin([page([value])]),"synthetic-filter"))[0].refunds[0].transactions.length,1);}});
