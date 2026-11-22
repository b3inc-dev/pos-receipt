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
  it("未分類の行が無い・0 円・壊れた JSON は false", () => {
    assert.equal(hasUnclassifiedPaymentSection(JSON.stringify([{ gateway: "現金", net: 100, refund: 0 }])), false);
    assert.equal(hasUnclassifiedPaymentSection(JSON.stringify([{ gateway: "未分類", net: 0, refund: 0 }])), false);
    assert.equal(hasUnclassifiedPaymentSection("{"), false);
    assert.equal(hasUnclassifiedPaymentSection(null), false);
  });
});
