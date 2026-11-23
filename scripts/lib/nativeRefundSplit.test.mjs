import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allRowsHaveMethod,
  canReassign,
  nativeRefundLineStatus,
  splitAmounts,
} from "../../extensions/common/nativeRefundSplit.js";

describe("純正の返金の付け替え（POS の計算）", () => {
  it("分けないときは残りの全額", () => {
    assert.deepEqual(splitAmounts(3000, [{ method: "cash" }]), { amounts: [3000], lastAmount: 3000, ok: true, error: "" });
  });
  it("最後の行は残額が自動で入る（合計は返金額と同じ）", () => {
    const r = splitAmounts(10000, [{ amount: "6000" }, { amount: "1000" }, { amount: "999999" }]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.amounts, [6000, 1000, 3000]);
    assert.equal(r.amounts.reduce((s, a) => s + a, 0), 10000);
  });
  it("分けた額が返金額以上なら登録できない", () => {
    assert.equal(splitAmounts(5000, [{ amount: "5000" }, {}]).ok, false);
    assert.equal(splitAmounts(5000, [{ amount: "6000" }, {}]).ok, false);
  });
  it("分けた行の金額が空・0 なら登録できない", () => {
    assert.equal(splitAmounts(5000, [{ amount: "" }, {}]).ok, false);
    assert.equal(splitAmounts(5000, [{ amount: "0" }, {}]).ok, false);
  });
  it("残りが無い行は付け替えできず「付け替え済み」", () => {
    assert.equal(canReassign({ remaining: 0 }), false);
    assert.equal(nativeRefundLineStatus({ remaining: 0, reassigned: 3000 }), "返金方法変更済み");
    assert.match(nativeRefundLineStatus({ remaining: 1000, reassigned: 2000 }), /残り ¥1,000/);
    assert.equal(nativeRefundLineStatus({ remaining: 3000, reassigned: 0 }), "");
  });
  it("手段はマスタの中から全部の行で選ぶ", () => {
    const master = [{ value: "cash" }, { value: "points" }];
    assert.equal(allRowsHaveMethod([{ method: "cash" }, { method: "points" }], master), true);
    assert.equal(allRowsHaveMethod([{ method: "cash" }, { method: "" }], master), false);
    assert.equal(allRowsHaveMethod([{ method: "card" }], master), false);
  });
});
