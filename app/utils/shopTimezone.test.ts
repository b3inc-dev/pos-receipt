import { test } from "node:test";
import assert from "node:assert/strict";
import { getDayRangeInUtc, getDayRangeShopifySearchIso } from "./shopTimezone.server";

// Shopify の注文検索に渡す日の区切り。オフセット付き（+09:00）を渡さないこと。
test("Asia/Tokyo: 日本時間の 0 時〜23:59 を Z 表記で返す", () => {
  const r = getDayRangeShopifySearchIso("2026-11-23", "Asia/Tokyo");
  assert.equal(r.start, "2026-11-22T15:00:00Z");
  assert.equal(r.end, "2026-11-23T14:59:59.999Z");
});

test("Asia/Tokyo: +09:00 などのオフセットを含まない", () => {
  const r = getDayRangeShopifySearchIso("2026-01-01", "Asia/Tokyo");
  for (const v of [r.start, r.end]) {
    assert.ok(v.endsWith("Z"), v);
    assert.ok(!v.includes("+"), v);
  }
  assert.equal(r.start, "2025-12-31T15:00:00Z");
});

test("getDayRangeInUtc と同じ瞬間（範囲は変えない）", () => {
  for (const tz of ["Asia/Tokyo", "America/New_York", "UTC"]) {
    const a = getDayRangeShopifySearchIso("2026-07-05", tz);
    const b = getDayRangeInUtc("2026-07-05", tz);
    assert.equal(a.start, b.startUtcIso);
    assert.equal(a.end, b.endUtcIso);
    assert.equal(new Date(a.start).getTime(), b.startUtc.getTime());
    assert.equal(new Date(a.end).getTime(), b.endUtc.getTime());
  }
});

test("同日 18:14 JST の注文（#1018 相当）が範囲に入る", () => {
  const r = getDayRangeShopifySearchIso("2026-11-23", "Asia/Tokyo");
  const t = new Date("2026-11-23T18:14:00+09:00").getTime();
  assert.ok(t >= new Date(r.start).getTime() && t <= new Date(r.end).getTime());
});
