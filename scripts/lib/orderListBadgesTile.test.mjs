import assert from "node:assert/strict";
import { test } from "node:test";
const load = async () => (await import("../../extensions/pos-smart-grid/src/orderDisplayUtils.js")).formatListBadgesForTile;

const item = {
  financialStatus: "PARTIALLY_REFUNDED",
  posBadges: { refundedShopify: true, hasVoucherAdjustment: true, hasVoucherChange: true, hasSpecialRefund: true },
};

test("返金方法変更のタイルは返金のバッジだけ（T 2026-11-24）", async () => {
  const formatListBadgesForTile = await load();
  assert.deepEqual(formatListBadgesForTile(item, "refunded").map((b) => b.label), ["一部返金", "特殊返金登録済"]);
});

test("商品券釣銭登録のタイルは商品券のバッジだけ", async () => {
  const formatListBadgesForTile = await load();
  assert.deepEqual(formatListBadgesForTile(item, "voucher_change").map((b) => b.label), ["商品券登録済", "商品券釣有り"]);
});

test("タイルが分からないときは全部", async () => {
  const formatListBadgesForTile = await load();
  assert.equal(formatListBadgesForTile(item, "all").length, 4);
});
