import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSettlementOrderSyncOptions } from "./settlementSyncSettings.server";

describe("resolveSettlementOrderSyncOptions", () => {
  it("never creates Shopify settlement/inspection orders", async () => {
    for (const mode of ["order_based", "cloudprnt_direct", "shopify_printing", ""]) {
      const opts = await resolveSettlementOrderSyncOptions("shop_any", mode);
      assert.equal(opts.createOrder, false);
      assert.equal(opts.attachNote, false);
      assert.equal(opts.attachMetafields, false);
    }
  });
});
