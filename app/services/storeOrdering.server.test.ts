import assert from "node:assert/strict";
import {mock,test} from "node:test";
let rows:any[]=[];let fail=false;
const tx:any={location:{createMany:async({data}:any)=>{for(const row of data)if(!rows.some(r=>r.shopId===row.shopId&&r.shopifyLocationGid===row.shopifyLocationGid))rows.push({...row,id:"new",sortOrder:0});},findMany:async({where}:any)=>rows.filter(r=>r.shopId===where.shopId&&where.shopifyLocationGid.in.includes(r.shopifyLocationGid)),
 updateMany:async({where,data}:any)=>{const r=rows.find(r=>r.id===where.id&&r.shopId===where.shopId&&r.sortOrder===where.sortOrder);if(!r||fail)return{count:0};r.sortOrder=data.sortOrder;return{count:1};}}};
mock.module("../db.server",{defaultExport:{$transaction:async(work:any)=>{const old=structuredClone(rows);try{return await work(tx);}catch(e){rows=old;throw e;}}}});
const {saveStoreOrder}=await import("./storeOrdering.server");
function reset(){fail=false;rows=[{id:"a",shopId:"s",shopifyLocationGid:"gid://shopify/Location/1",sortOrder:0,enabled:true},{id:"b",shopId:"s",shopifyLocationGid:"gid://shopify/Location/2",sortOrder:9,enabled:false},{id:"old",shopId:"s",shopifyLocationGid:"gid://shopify/Location/3",sortOrder:4},{id:"other",shopId:"other",shopifyLocationGid:"gid://shopify/Location/8",sortOrder:7}];}
test("自店の一覧対象だけ表示順を保存。休止店舗や他店、機能設定は保持",async()=>{
 reset();await saveStoreOrder("s",["2","1"],{"1":0,"2":9});assert.deepEqual(rows.map(r=>r.sortOrder),[2,1,4,7]);assert.deepEqual(rows.slice(0,2).map(r=>r.enabled),[true,false]);
});
test("他ストアID/重複/古い表示順/保存途中の競合は全件取り消す",async()=>{
 for(const [order,baseline] of [[["8","1"],{"8":7,"1":0}],[["1","1"],{"1":0}],[["2","1"],{"1":1,"2":9}]] as const){reset();const before=structuredClone(rows);await assert.rejects(()=>saveStoreOrder("s",order,baseline));assert.deepEqual(rows,before);}
 reset();fail=true;const before=structuredClone(rows);await assert.rejects(()=>saveStoreOrder("s",["2","1"],{"1":0,"2":9}));assert.deepEqual(rows,before);
});

test("初期設定前のDB未登録店舗はShopify確認済みの場合だけ作成し並び替えられる",async()=>{
 reset();rows=rows.filter(r=>r.id!=="a");
 await saveStoreOrder("s",["2","1"],{"1":0,"2":9},[{id:"gid://shopify/Location/1",name:"新店舗"},{id:"gid://shopify/Location/2",name:"既存店舗"}]);
 assert.equal(rows.find(r=>r.id==="new").sortOrder,2);assert.equal(rows.find(r=>r.id==="b").enabled,false);
 reset();const before=structuredClone(rows);
 await assert.rejects(()=>saveStoreOrder("s",["8","1"],{"8":0,"1":0},[{id:"gid://shopify/Location/1",name:"自店"}]));assert.deepEqual(rows,before);
});
