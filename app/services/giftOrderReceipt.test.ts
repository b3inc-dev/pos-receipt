import test from "node:test";
import assert from "node:assert/strict";
import { giftOrderHtml, GIFT_ORDER_QUERY } from "./giftOrderReceipt";

for (const width of [58, 80] as const) {
  test(`ギフトは${width}mmで全ページの品名と数量のみ印字する`, async () => {
    assert.doesNotMatch(GIFT_ORDER_QUERY, /price|money|discount|payment|transactions|customAttributes|subtotal|totalTax/i);
    const cursors: (string | null)[] = [];
    const html = await giftOrderHtml(async (cursor) => {
      cursors.push(cursor);
      return { name: "#123", lineItems: {
        nodes: [{ name: cursor ? "商品B" : "<商品A>", quantity: 2, unitPrice: 991122, customAttributes: ["内部メモ"] }],
        pageInfo: { hasNextPage: !cursor, endCursor: "line1" },
      } };
    }, width);
    assert.deepEqual(cursors, [null, "line1"]);
    assert.ok(html);
    assert.ok(html.includes(`data-paper-width-mm="${width}"`));
    assert.match(html, /ギフトレシート/);
    assert.match(html, /&lt;商品A&gt;/);
    assert.match(html, /商品B/);
    assert.match(html, /数量 2/);
    assert.doesNotMatch(html, /991122|内部メモ|<商品A>|小計|合計|支払|割引|¥/);
  });
}

test("ギフトの次ページ取得失敗で部分帳票を出さない", async () => {
  assert.equal(await giftOrderHtml(async () => null, 58), null);
  await assert.rejects(giftOrderHtml(async () => ({ name: "#123", lineItems: {
    nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" },
  } }), 80), /すべての明細/);
});
