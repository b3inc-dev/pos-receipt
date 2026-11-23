import assert from "node:assert/strict";
import { test } from "node:test";
import { voucherFaceCandidates } from "../../extensions/common/voucherFaceCandidates.js";

test("払った額より大きい 500 円刻みの候補を 3 つ", () => {
  assert.deepEqual(voucherFaceCandidates(2230), [2500, 3000, 3500]);
  assert.deepEqual(voucherFaceCandidates(4750), [5000, 5500, 6000]);
});

test("ちょうど 500 の倍数なら次から（釣銭が出る額だけ）", () => {
  assert.deepEqual(voucherFaceCandidates(2500), [3000, 3500, 4000]);
});

test("額が無い・0 以下・数字でないときは出さない", () => {
  assert.deepEqual(voucherFaceCandidates(0), []);
  assert.deepEqual(voucherFaceCandidates(-1), []);
  assert.deepEqual(voucherFaceCandidates("abc"), []);
  assert.deepEqual(voucherFaceCandidates(null), []);
});
