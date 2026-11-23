import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  paymentMethodsWithOrderGateway,
  primarySaleTransaction,
} from "../../extensions/common/paymentMethodFallback.js";

const order = {
  transactions: [
    { kind: "SALE", status: "SUCCESS", gateway: "cash", amount: "100", displayName: "現金" },
    {
      kind: "CAPTURE",
      status: "SUCCESS",
      gateway: "credit_card",
      amount: "3000",
      displayName: "クレジットカード",
    },
  ],
};

describe("payment method fallback", () => {
  it("最大の売上取引gatewayを返金元として選ぶ", () => {
    assert.equal(primarySaleTransaction(order)?.gateway, "credit_card");
  });

  it("同期失敗時のfallbackにも注文gatewayを残す", () => {
    const methods = paymentMethodsWithOrderGateway(
      [
        { value: "cash", label: "現金" },
        { value: "manual", label: "手動決済" },
      ],
      order,
    );
    assert.deepEqual(methods.at(-1), {
      value: "credit_card",
      label: "クレジットカード",
    });
  });

  it("金額が大きくても失敗取引を返金元に選ばない", () => {
    const selected = primarySaleTransaction({
      transactions: [
        { kind: "SALE", status: "FAILURE", gateway: "failed_card", amount: "5000" },
        { kind: "SALE", status: "SUCCESS", gateway: "cash", amount: "3000" },
      ],
    });
    assert.equal(selected?.gateway, "cash");
  });
});
