import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCustomerDataInventory,
  expandOrderIdVariants,
  summarizeInventoryForLog,
} from "./gdprCustomerDataRequest.server";

describe("expandOrderIdVariants", () => {
  it("数値・GID の両方を列挙する", () => {
    const variants = expandOrderIdVariants([299938, "gid://shopify/Order/280263"]);
    assert.ok(variants.includes("299938"));
    assert.ok(variants.includes("gid://shopify/Order/299938"));
    assert.ok(variants.includes("280263"));
    assert.ok(variants.includes("gid://shopify/Order/280263"));
  });

  it("空・未定義は空配列", () => {
    assert.deepEqual(expandOrderIdVariants([]), []);
    assert.deepEqual(expandOrderIdVariants(null), []);
    assert.deepEqual(expandOrderIdVariants(undefined), []);
  });
});

describe("buildCustomerDataInventory", () => {
  it("連絡先非保存の根拠と注文紐づけ行を列挙する", () => {
    const inventory = buildCustomerDataInventory({
      shopDomain: "example.myshopify.com",
      payload: {
        customer: { id: 191167, email: "a@b.com", phone: "555" },
        orders_requested: [100],
        data_request: { id: 9999 },
      },
      receiptIssues: [
        {
          orderId: "100",
          orderName: "#1001",
          recipientName: "山田太郎",
          amount: "1200",
          currency: "JPY",
          proviso: "お買上品代として",
          locationId: "gid://shopify/Location/1",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
          isReissue: false,
        },
      ],
      specialRefundEvents: [
        {
          sourceOrderId: "100",
          sourceOrderName: "#1001",
          eventType: "cash_refund",
          amount: "500",
          currency: "JPY",
          originalPaymentMethod: "credit",
          actualRefundMethod: "cash",
          note: "店頭",
          status: "active",
          createdAt: new Date("2026-01-02T01:00:00.000Z"),
        },
      ],
    });

    assert.equal(inventory.storesCustomerEmailOrPhone, false);
    assert.equal(inventory.webhookHadCustomerEmail, true);
    assert.equal(inventory.webhookHadCustomerPhone, true);
    assert.equal(inventory.receiptIssues.length, 1);
    assert.equal(inventory.receiptIssues[0].hasRecipientName, true);
    assert.equal(inventory.receiptIssues[0].recipientName, "山田太郎");
    assert.equal(inventory.specialRefundEvents.length, 1);
    assert.ok(inventory.rationale.notStored.length >= 1);
    assert.ok(inventory.rationale.storedLinkedToOrders.length >= 1);
  });

  it("ログサマリに宛名本文を含めない", () => {
    const inventory = buildCustomerDataInventory({
      shopDomain: "example.myshopify.com",
      payload: { orders_requested: [1], data_request: { id: 1 } },
      receiptIssues: [
        {
          orderId: "1",
          orderName: "#1",
          recipientName: "秘密の宛名",
          amount: "1",
          currency: "JPY",
          proviso: null,
          locationId: "loc",
          createdAt: "2026-01-01T00:00:00.000Z",
          isReissue: false,
        },
      ],
      specialRefundEvents: [],
    });
    const summary = summarizeInventoryForLog(inventory);
    const dumped = JSON.stringify(summary);
    assert.equal(summary.receiptIssueCount, 1);
    assert.equal(summary.receiptIssuesWithRecipientName, 1);
    assert.equal(dumped.includes("秘密の宛名"), false);
  });
});
