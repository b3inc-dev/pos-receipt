import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { financialStatusTone, orderPaymentSummaryLines } from "../../extensions/common/orderDetailLayout.js";

describe("orderPaymentSummaryLines", () => {
  it("支払いと返金を支払方法ごとに出し、返金は赤のマイナス", () => {
    const lines = orderPaymentSummaryLines({
      transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "cash", displayName: "現金", amount: "3325" }],
      refunds: [{ totalRefunded: "1100", transactions: [{ gateway: "cash", displayName: "現金", amount: "1100" }] }],
    });
    assert.deepEqual(
      lines.map((l) => [l.label, l.value, l.tone]),
      [
        ["支払い ・ 現金", "¥3,325", undefined],
        ["返金 ・ 現金", "−¥1,100", "critical"],
      ],
    );
  });

  it("返金の取引が無く返金額だけあるときは合計を 1 行", () => {
    const lines = orderPaymentSummaryLines({
      transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "cash", displayName: "現金", amount: "500" }],
      refunds: [{ totalRefunded: "200", transactions: [] }],
    });
    assert.deepEqual(lines.at(-1), { key: "refund-total", label: "返金", value: "−¥200", tone: "critical" });
  });

  it("失敗した取引は出さない・注文が無くても落ちない", () => {
    assert.deepEqual(
      orderPaymentSummaryLines({ transactions: [{ kind: "SALE", status: "FAILURE", gateway: "cash", amount: "100" }] }),
      [],
    );
    assert.deepEqual(orderPaymentSummaryLines(null), []);
  });
});

describe("financialStatusTone", () => {
  it("キャンセル=赤、返金=黄、ほか=灰", () => {
    assert.equal(financialStatusTone("PAID", "2026-11-23T00:00:00Z"), "critical");
    assert.equal(financialStatusTone("PARTIALLY_REFUNDED"), "warning");
    assert.equal(financialStatusTone("REFUNDED"), "warning");
    assert.equal(financialStatusTone("PAID"), "neutral");
  });
});
