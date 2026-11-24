/**
 * Phase 1 — 返金計上ロケーション解決の純関数テスト
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  locationGidMatches,
  normalizeLocationGid,
  orderHasRefundInDay,
  resolveNonPosRefundFallbackGid,
  resolveRefundAggregationLocationGid,
  specialRefundLocationForLatestNonPosRefund,
  type OrderForRefundAggregation,
  type RefundAggregationContext,
} from "./refundAggregationPure.server";

const locA = "gid://shopify/Location/100";
const locB = "gid://shopify/Location/200";

describe("normalizeLocationGid / locationGidMatches", () => {
  it("数値・パス・GID を正規化し、精算ロケと照合する", () => {
    assert.equal(normalizeLocationGid("100"), locA);
    assert.equal(normalizeLocationGid(locA), locA);
    assert.equal(locationGidMatches(locA, locA, "100"), true);
    assert.equal(locationGidMatches(locA, "gid://shopify/Location/100", "100"), true);
    assert.equal(locationGidMatches(null, locA, "100"), false);
    assert.equal(locationGidMatches(locB, locA, "100"), false);
  });

  it("表記ゆれ（数値 vs GID、locIdRaw フォールバック、空白）でも一致する", () => {
    assert.equal(locationGidMatches("100", locA, "100"), true);
    assert.equal(locationGidMatches(locA, "100", "100"), true);
    assert.equal(locationGidMatches("100", "100"), true);
    assert.equal(locationGidMatches(" 100 ", locA), true);
    assert.equal(locationGidMatches("/Location/100", "gid://shopify/Location/100"), true);
    // settlementLocationId がパース不能なときだけ locIdRaw を使う
    assert.equal(locationGidMatches(locA, "not-a-location", "100"), true);
    // settlement が別ロケ GID なら locIdRaw が一致しても不一致（取り違え防止）
    assert.equal(locationGidMatches(locA, "gid://shopify/Location/999", "100"), false);
    assert.equal(locationGidMatches(locB, "100", "100"), false);
  });
});

describe("resolveRefundAggregationLocationGid", () => {
  const baseOrder: OrderForRefundAggregation = {
    id: "gid://shopify/Order/1",
    retailLocation: { id: locA },
    transactions: [],
    refunds: [
      {
        createdAt: "2026-10-08T02:00:00Z",
        transactions: [{ id: "r1", kind: "REFUND", location: { id: locB } }],
      },
    ],
  };

  it("mode=refund_transaction_pos_location は返金 TX の POS ロケを返す", () => {
    const ctx: RefundAggregationContext = {
      mode: "refund_transaction_pos_location",
      nonPosRefundFallbackMode: "order_retail_location",
      nonPosRefundTargetLocationGid: null,
    };
    assert.equal(resolveRefundAggregationLocationGid(baseOrder, ctx), locB);
  });

  it("mode=order_transaction で返金 TX ロケありなら retail を優先", () => {
    const ctx: RefundAggregationContext = {
      mode: "order_transaction",
      nonPosRefundFallbackMode: "order_retail_location",
      nonPosRefundTargetLocationGid: null,
    };
    assert.equal(resolveRefundAggregationLocationGid(baseOrder, ctx), locA);
  });

  it("POS ロケ無し + nonPos target があれば target を返す", () => {
    const order: OrderForRefundAggregation = {
      id: "o",
      retailLocation: { id: locA },
      refunds: [{ createdAt: "2026-10-08T02:00:00Z", transactions: [{ id: "r1", kind: "REFUND" }] }],
    };
    const ctx: RefundAggregationContext = {
      mode: "order_transaction",
      nonPosRefundFallbackMode: "exclude",
      nonPosRefundTargetLocationGid: locB,
    };
    assert.equal(resolveRefundAggregationLocationGid(order, ctx), locB);
  });

  it("POS ロケ無し + fallback exclude + target 無しは null", () => {
    const order: OrderForRefundAggregation = {
      id: "o",
      retailLocation: { id: locA },
      refunds: [{ createdAt: "2026-10-08T02:00:00Z", transactions: [{ id: "r1", kind: "REFUND" }] }],
    };
    const ctx: RefundAggregationContext = {
      mode: "order_transaction",
      nonPosRefundFallbackMode: "exclude",
      nonPosRefundTargetLocationGid: null,
    };
    assert.equal(resolveRefundAggregationLocationGid(order, ctx), null);
  });
});

describe("orderHasRefundInDay", () => {
  it("返金オブジェクトまたは REFUND TX の createdAt で当日判定する", () => {
    const inDay = (iso?: string) => iso?.startsWith("2026-10-08") === true;
    assert.equal(
      orderHasRefundInDay(
        { id: "a", refunds: [{ createdAt: "2026-10-08T01:00:00Z" }] },
        inDay,
      ),
      true,
    );
    assert.equal(
      orderHasRefundInDay(
        {
          id: "b",
          transactions: [{ kind: "REFUND", createdAt: "2026-10-08T01:00:00Z" }],
        },
        inDay,
      ),
      true,
    );
    assert.equal(
      orderHasRefundInDay(
        { id: "c", refunds: [{ createdAt: "2026-10-07T01:00:00Z" }] },
        inDay,
      ),
      false,
    );
  });
});

describe("specialRefundLocationForLatestNonPosRefund（#119 見直し P2-A）", () => {
  const L = (n: number) => `gid://shopify/Location/${n}`;
  const refund = (id: string | undefined, at: string, loc: number | null) => ({
    id,
    createdAt: at,
    transactions: [{ kind: "REFUND", location: loc ? { id: L(loc) } : null }],
  });

  it("返金 ID が数字だけ・GID のどちらでも照らせる", () => {
    const order = { refunds: [refund("gid://shopify/Refund/55", "2026-11-24T03:00:00Z", null)] };
    assert.equal(
      specialRefundLocationForLatestNonPosRefund(order, [{ locationId: "200", shopifyRefundId: "55" }]),
      L(200),
    );
    assert.equal(
      specialRefundLocationForLatestNonPosRefund(order, [
        { locationId: L(200), shopifyRefundId: "gid://shopify/Refund/55" },
      ]),
      L(200),
    );
  });

  it("返金 ID が取れない・特殊返金と合わない・店の付いた返金だけ: null（今までどおり resolve）", () => {
    const ev = [{ locationId: L(200), shopifyRefundId: "55" }];
    assert.equal(
      specialRefundLocationForLatestNonPosRefund({ refunds: [refund(undefined, "2026-11-24T03:00:00Z", null)] }, ev),
      null,
    );
    assert.equal(
      specialRefundLocationForLatestNonPosRefund({ refunds: [refund("56", "2026-11-24T03:00:00Z", null)] }, ev),
      null,
    );
    assert.equal(
      specialRefundLocationForLatestNonPosRefund({ refunds: [refund("55", "2026-11-24T03:00:00Z", 300)] }, ev),
      null,
    );
    assert.equal(specialRefundLocationForLatestNonPosRefund({ refunds: [] }, ev), null);
  });

  it("同じ返金 ID の行が 2 つ（変更で置き換えた）: 新しい行の店", () => {
    const order = { refunds: [refund("55", "2026-11-24T03:00:00Z", null)] };
    assert.equal(
      specialRefundLocationForLatestNonPosRefund(order, [
        { locationId: L(200), shopifyRefundId: "55", createdAt: "2026-11-24T03:00:00Z" },
        { locationId: L(400), shopifyRefundId: "55", createdAt: "2026-11-24T04:00:00Z" },
      ]),
      L(400),
    );
  });
});

describe("resolveNonPosRefundFallbackGid", () => {
  const order = { retailLocation: { id: "gid://shopify/Location/100" } };
  it("計上先の店 → 数えない → 販売店", () => {
    assert.equal(
      resolveNonPosRefundFallbackGid(order, {
        mode: "refund_transaction_pos_location",
        nonPosRefundFallbackMode: "exclude",
        nonPosRefundTargetLocationGid: "gid://shopify/Location/300",
      }),
      "gid://shopify/Location/300",
    );
    assert.equal(
      resolveNonPosRefundFallbackGid(order, {
        mode: "refund_transaction_pos_location",
        nonPosRefundFallbackMode: "exclude",
        nonPosRefundTargetLocationGid: null,
      }),
      null,
    );
    assert.equal(
      resolveNonPosRefundFallbackGid(order, {
        mode: "refund_transaction_pos_location",
        nonPosRefundFallbackMode: "order_retail_location",
        nonPosRefundTargetLocationGid: null,
      }),
      "gid://shopify/Location/100",
    );
  });
});
