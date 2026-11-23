import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchQuery } from "./orderSearchQuery";

test("注文の一覧: 日本の店は日本時間の 0 時〜23:59 で区切る", () => {
  assert.equal(
    buildSearchQuery({ locationId: "gid://shopify/Location/1001", dateFrom: "2026-11-23", dateTo: "2026-11-23", timezone: "Asia/Tokyo" }),
    "location_id:1001 AND source_name:pos AND created_at:>=2026-11-23T00:00:00+09:00 AND created_at:<=2026-11-23T23:59:59.999+09:00",
  );
});

test("注文の一覧: ほかのタイムゾーンはその 0 時を UTC で", () => {
  const q = buildSearchQuery({ dateFrom: "2026-11-23", dateTo: "2026-11-23", timezone: "America/New_York" });
  assert.equal(q, "created_at:>=2026-11-23T05:00:00Z AND created_at:<=2026-11-24T04:59:59.999Z");
});

test("注文の一覧: 注文番号で探すときは日付を付けない", () => {
  assert.equal(
    buildSearchQuery({ q: "#1234", locationId: "1001", dateFrom: "2026-11-23", dateTo: "2026-11-23", timezone: "Asia/Tokyo" }),
    "name:1234 AND location_id:1001 AND source_name:pos",
  );
});
