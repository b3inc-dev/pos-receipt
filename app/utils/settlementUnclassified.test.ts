import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasUnclassifiedPaymentSection } from "./settlementUnclassified";
import { UNMATCHED_REFUND_SECTION_KEY } from "../services/specialRefundOverlayPure.server";

describe("hasUnclassifiedPaymentSection", () => {
  it("精算エンジンの未分類の行と同じ名前", () => {
    assert.equal(UNMATCHED_REFUND_SECTION_KEY, "未分類");
  });
  it("未分類の行に金額があれば true", () => {
    assert.equal(
      hasUnclassifiedPaymentSection(JSON.stringify([{ gateway: "現金", net: 100, refund: 0 }, { gateway: "未分類", net: 0, refund: 300 }])),
      true,
    );
  });
  it("#22 の新しい形（{ format, snapshot, sections }）も読む", () => {
    const json = JSON.stringify({
      format: "settlement_print_v1",
      snapshot: { formVersion: "settlement-receipt-v1", locationName: "店", title: "【精算レシート】", isInspection: false },
      sections: [{ gateway: "未分類", label: "未分類", net: 0, refund: 300, txCount: 0, refundCount: 1 }],
    });
    assert.equal(hasUnclassifiedPaymentSection(json), true);
    assert.equal(
      hasUnclassifiedPaymentSection(JSON.stringify({ format: "settlement_print_v1", sections: [{ gateway: "現金", net: 1, refund: 0 }] })),
      false,
    );
    assert.equal(hasUnclassifiedPaymentSection(JSON.stringify({ format: "settlement_print_v1" })), false);
  });
  it("未分類の行が無い・0 円・壊れた JSON は false", () => {
    assert.equal(hasUnclassifiedPaymentSection(JSON.stringify([{ gateway: "現金", net: 100, refund: 0 }])), false);
    assert.equal(hasUnclassifiedPaymentSection(JSON.stringify([{ gateway: "未分類", net: 0, refund: 0 }])), false);
    assert.equal(hasUnclassifiedPaymentSection("{"), false);
    assert.equal(hasUnclassifiedPaymentSection(null), false);
  });
});
