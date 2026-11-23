import { test } from "node:test";
import assert from "node:assert/strict";
import { searchDateCondition, searchDateRange } from "./shopifySearchDate";
import { getDayRangeInUtc } from "./shopTimezone.server";

test("日時の値を二重引用符で囲む", () => {
  assert.equal(
    searchDateCondition("created_at", ">=", "2026-11-19T15:00:00Z"),
    'created_at:>="2026-11-19T15:00:00Z"',
  );
});

test("日本の 1 日の範囲（Z 表記・引用符つき）", () => {
  const r = getDayRangeInUtc("2026-11-20", "Asia/Tokyo");
  assert.equal(
    searchDateRange("created_at", r.startUtcIso, r.endUtcIso),
    'created_at:>="2026-11-19T15:00:00Z" created_at:<="2026-11-20T14:59:59.999Z"',
  );
});

test("引用符・空白を含む値は使わない", () => {
  assert.throws(() => searchDateCondition("created_at", ">=", 'x" OR tag:a'));
  assert.throws(() => searchDateCondition("created_at", ">=", "2026-11-23T00:00:00 09:00"));
  assert.throws(() => searchDateCondition("created_at", ">=", ""));
});
