import assert from "node:assert/strict";
import {test} from "node:test";
import {moveStore,parseStoreOrder} from "./storeOrdering";
test("上下/番号で移動し、絞り込み中も非表示店舗を失わない",()=>{
 const order=["1","2","3","4"];
 assert.deepEqual(moveStore(order,"4",1),["4","1","2","3"]);
 assert.deepEqual(moveStore(order,"1",4),["2","3","4","1"]);
 assert.deepEqual(moveStore(order,"4",2),["1","4","2","3"]);
 for(const n of [0,-1,5,NaN,1.5])assert.deepEqual(moveStore(order,"1",n),order);
 assert.deepEqual(order,["1","2","3","4"]);
});
test("他店舗混入をサーバーで検証する前に、重複/不正な表示順を拒む",()=>{
 for(const v of [["1","1"],[1,2],["gid://shopify/Location/1"],{},null])assert.equal(parseStoreOrder(v),null);
 assert.deepEqual(parseStoreOrder(["2","1"]),["2","1"]);
});
