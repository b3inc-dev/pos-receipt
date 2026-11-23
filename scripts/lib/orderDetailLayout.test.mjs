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
  it("一覧のバッジと同じ: キャンセル=赤、一部返金=黄、返金済=橙、ほか=灰", () => {
    assert.equal(financialStatusTone("PAID", "2026-11-23T00:00:00Z"), "critical");
    assert.equal(financialStatusTone("PARTIALLY_REFUNDED"), "caution");
    assert.equal(financialStatusTone("REFUNDED"), "warning");
    assert.equal(financialStatusTone("PAID"), "neutral");
  });
});

describe("customerLabel", async () => {
  const { customerLabel } = await import("../../extensions/common/orderDetailLayout.js");
  it("名前 → 名前、名前なしで読み直したとき → 顧客あり、顧客がいない → 顧客なし", () => {
    assert.equal(customerLabel({ customer: { id: "gid://shopify/Customer/1", displayName: "山田 太郎" } }), "山田 太郎");
    assert.equal(customerLabel({ customer: { id: "gid://shopify/Customer/1" } }), "顧客あり（名前は表示できません）");
    assert.equal(customerLabel({ customer: null }), "顧客なし");
    assert.equal(customerLabel(null), "顧客なし");
  });
});
