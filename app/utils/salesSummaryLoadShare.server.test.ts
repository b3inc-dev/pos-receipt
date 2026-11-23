import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetSalesSummaryLoadShareForTest,
  parseSalesSummaryLoadId,
  shareWithinLoad,
} from "./salesSummaryLoadShare.server";

test("同じ loadId・同じキーの計算は 1 回だけ走り、同じ結果を返す", async () => {
  __resetSalesSummaryLoadShareForTest();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return { actual: 100 };
  };
  const [a, b] = await Promise.all([
    shareWithinLoad("load-abc1", "loc|shop1|L1|2026-11-23", fn),
    shareWithinLoad("load-abc1", "loc|shop1|L1|2026-11-23", fn),
  ]);
  // 片方が終わった後に来ても同じ読み込みの中なら共有
  const c = await shareWithinLoad("load-abc1", "loc|shop1|L1|2026-11-23", fn);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test("loadId が違う・無い・キーが違うときは毎回数える", async () => {
  __resetSalesSummaryLoadShareForTest();
  let calls = 0;
  const fn = async () => ++calls;
  await shareWithinLoad("load-abc1", "k1", fn);
  await shareWithinLoad("load-abc2", "k1", fn); // 再読み込み（新しい loadId）
  await shareWithinLoad("load-abc1", "k2", fn); // 別の店・日
  await shareWithinLoad(null, "k1", fn); // loadId なし（古い POS・webhook）
  await shareWithinLoad(null, "k1", fn);
  assert.equal(calls, 5);
});

test("失敗した計算は共有から外れ、次はやり直す", async () => {
  __resetSalesSummaryLoadShareForTest();
  let calls = 0;
  const bad = async () => {
    calls += 1;
    throw new Error("Throttled");
  };
  await assert.rejects(shareWithinLoad("load-abc1", "k", bad));
  const ok = await shareWithinLoad("load-abc1", "k", async () => {
    calls += 1;
    return "ok";
  });
  assert.equal(ok, "ok");
  assert.equal(calls, 2);
});

test("loadId の検証", () => {
  assert.equal(parseSalesSummaryLoadId("mlt3k2ab9x1"), "mlt3k2ab9x1");
  assert.equal(parseSalesSummaryLoadId(null), null);
  assert.equal(parseSalesSummaryLoadId(""), null);
  assert.equal(parseSalesSummaryLoadId("abc"), null); // 短すぎ
  assert.equal(parseSalesSummaryLoadId("a|b|c|d|e|f"), null); // 区切り文字は不可
  assert.equal(parseSalesSummaryLoadId("x".repeat(65)), null);
});
