/**
 * 点検・精算の注文: 下書きの確定のあと、確定の返りの注文をそのまま使う。
 *
 * 2026-11-23 開発ストア: 点検の注文（0 円）はできたのに、すぐあとのタグ検索が反映待ちで空のまま
 * 「点検注文の確定後に注文を検索できませんでした」で失敗し、記録が残らなかった。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSettlementOrderAlwaysGas,
  createZeroInspectionOrderGas,
} from "./settlementOrderGas.server";

type Call = { query: string; variables: Record<string, unknown> };

function fakeAdmin(opts: {
  completeOrder: { id: string; name: string } | null;
  draftNodeOrder?: { id: string; name: string } | null;
  searchHits?: { id: string; name: string }[];
}) {
  const calls: Call[] = [];
  const reply = (data: unknown) => ({ json: async () => ({ data }) });
  const admin = {
    graphql: async (query: string, o?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: o?.variables ?? {} });
      if (query.includes("customers(")) {
        return reply({ customers: { edges: [{ node: { id: "gid://shopify/Customer/1" } }] } });
      }
      if (query.includes("draftOrderCreate")) {
        return reply({ draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/9" }, userErrors: [] } });
      }
      if (query.includes("draftOrderComplete")) {
        return reply({
          draftOrderComplete: {
            draftOrder: { id: "gid://shopify/DraftOrder/9", order: opts.completeOrder },
            userErrors: [],
          },
        });
      }
      if (query.includes("GasDraftOrderOrder")) {
        return reply({ node: { order: opts.draftNodeOrder ?? null } });
      }
      if (query.includes("orders(")) {
        return reply({ orders: { edges: (opts.searchHits ?? []).map((n) => ({ node: n })) } });
      }
      if (query.includes("metafieldsSet")) {
        return reply({ metafieldsSet: { metafields: [], userErrors: [] } });
      }
      throw new Error(`想定外の問い合わせ: ${query.slice(0, 80)}`);
    },
  };
  return { admin, calls };
}

const ORDER = { id: "gid://shopify/Order/1021", name: "#1021" };

describe("点検の注文", () => {
  it("確定の返りに注文があれば、検索が空でもその注文を使う（検索しない）", async () => {
    const { admin, calls } = fakeAdmin({ completeOrder: ORDER, searchHits: [] });
    const r = await createZeroInspectionOrderGas(admin, "BBB渋谷店");
    assert.equal(r.orderId, ORDER.id);
    assert.equal(r.orderName, ORDER.name);
    assert.equal(calls.filter((c) => c.query.includes("orders(")).length, 0);
    assert.equal(calls.filter((c) => c.query.includes("draftOrderCreate")).length, 1);
  });

  it("確定の返りに注文が無ければ、下書きを読み直して注文を使う", async () => {
    const { admin } = fakeAdmin({ completeOrder: null, draftNodeOrder: ORDER, searchHits: [] });
    const r = await createZeroInspectionOrderGas(admin, "BBB渋谷店");
    assert.equal(r.orderId, ORDER.id);
  });
});

describe("精算の注文", () => {
  it("確定の返りに注文があれば、検索が空でもその注文を使う", async () => {
    const { admin, calls } = fakeAdmin({ completeOrder: ORDER, searchHits: [] });
    const r = await createSettlementOrderAlwaysGas(admin, "2026-11-23", "BBB渋谷店");
    assert.equal(r.orderId, ORDER.id);
    assert.equal(r.orderName, ORDER.name);
    assert.equal(calls.filter((c) => c.query.includes("orders(")).length, 0);
    assert.equal(calls.filter((c) => c.query.includes("GasDraftOrderOrder")).length, 0);
  });
});
