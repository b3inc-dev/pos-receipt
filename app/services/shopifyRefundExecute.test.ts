import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  executeShopifyRefundForEvent,
  isRetryableRefundError,
  pickParentTransactions,
  refundEventMarker,
  refundNoteMatchesEvent,
} from "./shopifyRefundExecute.server";

const sales = [
  {
    id: "cash-sale",
    kind: "SALE",
    status: "SUCCESS",
    gateway: "cash",
    amountSet: { shopMoney: { amount: "1000" } },
  },
  {
    id: "card-sale",
    kind: "SALE",
    status: "SUCCESS",
    gateway: "credit_card",
    amountSet: { shopMoney: { amount: "3000" } },
  },
];

describe("pickParentTransactions", () => {
  it("元の支払手段に一致する Shopify 親取引だけを返す", () => {
    const selected = pickParentTransactions(sales, "credit_card");
    assert.deepEqual(selected.map((tx) => tx.id), ["card-sale"]);
  });

  it("指定手段が存在しない場合は別 gateway へ fallback しない", () => {
    const selected = pickParentTransactions(sales, "unknown");
    assert.deepEqual(selected, []);
  });

  it("元手段未指定の場合だけ全売上を金額順で返す", () => {
    const selected = pickParentTransactions(sales, null);
    assert.deepEqual(selected.map((tx) => tx.id), ["card-sale", "cash-sale"]);
  });
});

describe("executeShopifyRefundForEvent", () => {
  it("解析済み GraphQL JSON を使い、同じ冪等キーで refundCreate を呼ぶ", async () => {
    const calls: Array<{ query: string; opts?: object }> = [];
    const admin = {
      graphql: async (query: string, opts?: object) => {
        calls.push({ query, opts });
        const payload = query.includes("OrderForRefund")
          ? {
              data: {
                order: {
                  id: "gid://shopify/Order/1",
                  // 成功応答喪失後の再送では既に全額返金済みになり得る。
                  refundable: false,
                  refunds: [],
                  transactions: [sales[1]],
                },
              },
            }
          : {
              data: {
                refundCreate: {
                  refund: { id: "gid://shopify/Refund/9" },
                  userErrors: [],
                },
              },
            };
        return { json: async () => payload };
      },
    };

    const result = await executeShopifyRefundForEvent(admin, {
      sourceOrderId: "1",
      amount: 500,
      eventType: "cash_refund",
      originalPaymentMethod: "credit_card",
      actualRefundMethod: "cash",
      idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
    });

    assert.deepEqual(result, {
      status: "success",
      refundId: "gid://shopify/Refund/9",
    });
    assert.equal(calls.length, 2);
    assert.match(calls[1].query, /@idempotent\(key: \$idempotencyKey\)/);
    assert.equal(
      (calls[1].opts as { variables: { idempotencyKey: string } }).variables.idempotencyKey,
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("24時間超の再送でも注文上のイベント印を照合し、返金を再作成しない", async () => {
    let calls = 0;
    const key = "123e4567-e89b-12d3-a456-426614174000";
    const admin = {
      graphql: async () => {
        calls += 1;
        return {
          json: async () => ({
            data: {
              order: {
                id: "gid://shopify/Order/1",
                refundable: false,
                refunds: [
                  {
                    id: "gid://shopify/Refund/9",
                    note: `${refundEventMarker(key)} / 特殊返金 / cash_refund`,
                  },
                ],
                transactions: [sales[1]],
              },
            },
          }),
        };
      },
    };

    const result = await executeShopifyRefundForEvent(admin, {
      sourceOrderId: "1",
      amount: 500,
      eventType: "cash_refund",
      originalPaymentMethod: "credit_card",
      actualRefundMethod: "cash",
      idempotencyKey: key,
    });

    assert.deepEqual(result, {
      status: "success",
      refundId: "gid://shopify/Refund/9",
    });
    assert.equal(calls, 1);
  });

  it("Shopify の同時冪等要求エラーは同じキーで再開できる状態として返す", async () => {
    const admin = {
      graphql: async (query: string) => ({
        json: async () =>
          query.includes("OrderForRefund")
            ? {
                data: {
                  order: {
                    id: "gid://shopify/Order/1",
                    refundable: true,
                    refunds: [],
                    transactions: [sales[1]],
                  },
                },
              }
            : {
                errors: [
                  {
                    message: "A request with this idempotency key is still running",
                    extensions: { code: "IDEMPOTENCY_CONCURRENT_REQUEST" },
                  },
                ],
              },
      }),
    };

    const result = await executeShopifyRefundForEvent(admin, {
      sourceOrderId: "1",
      amount: 500,
      eventType: "cash_refund",
      originalPaymentMethod: "credit_card",
      actualRefundMethod: "cash",
      idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
    });

    assert.deepEqual(result, {
      status: "retryable",
      error: "A request with this idempotency key is still running",
    });
  });
});

describe("isRetryableRefundError", () => {
  it("一時エラーだけを再試行可能に分類する", () => {
    assert.equal(
      isRetryableRefundError([
        { code: "IDEMPOTENCY_CONCURRENT_REQUEST", message: "in progress" },
      ]),
      true,
    );
    assert.equal(
      isRetryableRefundError([{ code: "TRANSACTION_AMOUNT_TOO_LARGE", message: "invalid" }]),
      false,
    );
  });
});

describe("refundNoteMatchesEvent", () => {
  it("キーの前方一致では別イベントを成功扱いにしない", () => {
    const shorter = "abcdefghijklmnop";
    const longer = "abcdefghijklmnopq";
    const note = `${refundEventMarker(longer)} / 特殊返金 / cash_refund`;
    assert.equal(refundNoteMatchesEvent(note, shorter), false);
    assert.equal(refundNoteMatchesEvent(note, longer), true);
  });
});
