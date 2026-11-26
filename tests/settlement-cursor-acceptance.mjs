import assert from "node:assert/strict";
import {before,after,test} from "node:test";
import {createServer} from "vite";
let vite,read,UpstreamError;
before(async()=>{vite=await createServer({configFile:false,appType:"custom",server:{middlewareMode:true,hmr:false}});const m=await vite.ssrLoadModule("/app/services/settlementUpstreamPage.server.ts");read=m.readOrdersPageOrThrow;UpstreamError=m.UpstreamAggregationError;});
after(async()=>{await vite?.close();});
const page=(cursor,next=true)=>({data:{orders:{nodes:[{id:"synthetic"}],pageInfo:{hasNextPage:next,endCursor:cursor}}}});
test("RECEIPT-CURSOR-CYCLE-001: repeated nonterminal cursors reject before a partial stream can finish",()=>{
 const seen=new Set();read(page("A"),"synthetic",seen);read(page("B"),"synthetic",seen);
 assert.throws(()=>read(page("A"),"synthetic",seen),UpstreamError,"repeated nonterminal cursor must reject");
});
test("independent streams and a terminal cursor remain valid without a new timeout contract",()=>{
 const one=new Set(),two=new Set();assert.equal(read(page("A"),"one",one).hasNextPage,true);
 assert.equal(read(page("A"),"two",two).hasNextPage,true);
 assert.equal(read(page("A",false),"one",one).hasNextPage,false);
});
