/**
 * 日次の「今日」は店のタイムゾーンの暦日にする（UTC の日付を使わない）。
 * 2026-11-23: 日本時間 4:39 に精算した 11/24 が、精算の履歴一覧に出なかった（UTC ではまだ 11/23 だった）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCalendarDateStringInTimeZone } from "./shopTimezone.server";

describe("店のタイムゾーンでの今日", () => {
  it("日本時間 0:00〜8:59 は UTC では前日だが、店の今日は当日", () => {
    const now = new Date("2026-11-23T19:39:00Z"); // 日本時間 2026-11-24 04:39
    assert.equal(now.toISOString().slice(0, 10), "2026-11-23");
    assert.equal(getCalendarDateStringInTimeZone(now, "Asia/Tokyo"), "2026-11-24");
  });
});
