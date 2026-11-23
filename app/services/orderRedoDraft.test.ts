import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRedoDraftFromOrder } from "./orderRedoDraft.server";

/** admin.graphql は Response のように json() を持つ。adminGraphqlWithRetry はそれを読んで返す */
function fakeAdmin(responses: unknown[]) {
  const calls: string[] = [];
  return {
    calls,
    async graphql(query: string) {
      calls.push(query.includes("draftOrderCreate") ? "create" : "read");
      const body = responses.shift();
      return { json: async () => body };
    },
  };
}

describe("createRedoDraftFromOrder", () => {
  it("注文を読んで下書きを作る（読んだ JSON をもう一度 json() しない）", async () => {
    const admin = fakeAdmin([
      {
        data: {
          order: {
            id: "gid://shopify/Order/1",
            name: "#1018",
            cancelledAt: null,
            displayFinancialStatus: "PARTIALLY_REFUNDED",
            refunds: [{ id: "r1" }],
            customer: null,
            lineItems: {
              nodes: [
                {
                  title: "BBB バスタオル",
                  quantity: 1,
                  variant: { id: "gid://shopify/ProductVariant/9" },
                  originalUnitPriceSet: { shopMoney: { amount: "3325", currencyCode: "JPY" } },
                  discountedUnitPriceSet: { shopMoney: { amount: "3325", currencyCode: "JPY" } },
                },
              ],
            },
          },
        },
      },
      {
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/5",
              name: "#D5",
              status: "OPEN",
              totalPriceSet: { shopMoney: { amount: "3325", currencyCode: "JPY" } },
            },
            userErrors: [],
          },
        },
      },
    ]);
    const res = await createRedoDraftFromOrder(admin, "1");
    assert.equal(res.ok, true);
    assert.deepEqual(admin.calls, ["read", "create"]);
    if (res.ok) assert.equal(res.draftOrder.name, "#D5");
  });
});
