/**
 * Phase 1 — 返金計上ロケーション解決の純関数テスト
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  locationGidMatches,
  normalizeLocationGid,
  orderHasRefundInDay,
  resolveRefundAggregationLocationGid,
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
