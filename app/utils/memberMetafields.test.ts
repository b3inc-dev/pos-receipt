import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memberMetafieldValues } from "./memberMetafields";

const v = (value: string) => ({ value });

describe("memberMetafieldValues", () => {
  it("Shop Point の値を優先し、無い項目だけ旧VIPを使う", () => {
    const out = memberMetafieldValues({
      spRankName: v("GOLD"),
      spPointsApproved: v("1200"),
      vipRankName: v("SILVER"),
      vipPointsApproved: v("900"),
      vipRankDecisionPurchasePrice: v("50000"),
      vipExpiryDate: v("2026-12-31"),
      vipExpiringPoints: v("10"),
    });
    assert.deepEqual(out, {
      rankName: "GOLD",
      pointsApproved: "1200",
      rankDecisionPurchasePrice: 50000,
      expiryDate: "2026-12-31",
      expiringPoints: "10",
    });
  });

  it("失効はいちばん早い日の点数を合計し、空の一覧は失効なしで旧VIPへ戻さない", () => {
    const list = [
      { expiresOn: "2027-03-01", points: 5 },
      { expiresOn: "2027-01-31", points: 20 },
      { expiresOn: "2027-01-31", points: 3 },
      { expiresOn: "bad", points: 1 },
    ];
    const out = memberMetafieldValues({ spUpcomingExpirations: v(JSON.stringify(list)), vipExpiryDate: v("2026-12-31") });
    assert.equal(out.expiryDate, "2027-01-31");
    assert.equal(out.expiringPoints, "23");
    const none = memberMetafieldValues({ spUpcomingExpirations: v("[]"), vipExpiryDate: v("2026-12-31"), vipExpiringPoints: v("10") });
    assert.equal(none.expiryDate, undefined);
    assert.equal(none.expiringPoints, undefined);
  });

  it("読めない一覧・負の金額は旧VIPへ戻す", () => {
    const out = memberMetafieldValues({
      spUpcomingExpirations: v("{"),
      spRankDecisionPurchasePrice: v("-1"),
      vipRankDecisionPurchasePrice: v("3000"),
      vipExpiryDate: v("2026-12-31"),
    });
    assert.equal(out.expiryDate, "2026-12-31");
    assert.equal(out.rankDecisionPurchasePrice, 3000);
    assert.deepEqual(memberMetafieldValues(null), {
      rankName: undefined, pointsApproved: undefined, rankDecisionPurchasePrice: undefined, expiryDate: undefined, expiringPoints: undefined,
    });
  });
});
