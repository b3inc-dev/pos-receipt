import assert from "node:assert/strict";
import { test } from "node:test";
import { voucherFaceCandidates } from "../../extensions/common/voucherFaceCandidates.js";

test("一番近い 100 円区切り 1 つ + 次に近い 500 円区切り 2 つ", () => {
  assert.deepEqual(voucherFaceCandidates(2230), [2300, 2500, 3000]);
  assert.deepEqual(voucherFaceCandidates(4750), [4800, 5000, 5500]);
  assert.deepEqual(voucherFaceCandidates(980), [1000, 1500, 2000]);
});

test("ちょうど 100 の倍数なら次の 100 円区切りから（釣銭が出る額だけ）", () => {
  assert.deepEqual(voucherFaceCandidates(2300), [2400, 2500, 3000]);
  assert.deepEqual(voucherFaceCandidates(2500), [2600, 3000, 3500]);
});

test("100 円区切りが 500 の倍数と重なるときは重複させず次の 500 円区切りで埋める", () => {
  assert.deepEqual(voucherFaceCandidates(2430), [2500, 3000, 3500]);
  assert.deepEqual(voucherFaceCandidates(2499), [2500, 3000, 3500]);
});

test("額が無い・0 以下・数字でないときは出さない", () => {
  assert.deepEqual(voucherFaceCandidates(0), []);
  assert.deepEqual(voucherFaceCandidates(-1), []);
  assert.deepEqual(voucherFaceCandidates("abc"), []);
  assert.deepEqual(voucherFaceCandidates(null), []);
});
