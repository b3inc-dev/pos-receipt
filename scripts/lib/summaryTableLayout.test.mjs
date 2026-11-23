/**
 * 精算・売上サマリーの表（見出しで区切る形, 2026-11-23）の表示の決まり。
 * 数え方は変えず、並べ方と書き方だけを見る。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chunkRows,
  formatDeduction,
  formatYen,
  formatYmdWithWeekday,
  splitMetricItems,
} from "../../extensions/common/summaryTableLayout.js";

describe("formatYen / formatDeduction", () => {
  it("円をカンマ区切りで出す", () => {
    assert.equal(formatYen(238400), "¥238,400");
    assert.equal(formatYen(null), "—");
  });
  it("差し引く金額は 0 より大きいときだけ − と赤", () => {
    assert.deepEqual(formatDeduction(12300), { text: "−¥12,300", tone: "critical" });
    assert.deepEqual(formatDeduction(0), { text: "¥0", tone: undefined });
    assert.deepEqual(formatDeduction(undefined), { text: "¥0", tone: undefined });
  });
});

describe("formatYmdWithWeekday", () => {
  it("曜日を付ける", () => {
    assert.equal(formatYmdWithWeekday("2026-11-23"), "2026/11/23（月）");
    assert.equal(formatYmdWithWeekday("2026-11-22"), "2026/11/22（日）");
  });
  it("形が違えばそのまま", () => {
    assert.equal(formatYmdWithWeekday("-"), "-");
    assert.equal(formatYmdWithWeekday(""), "—");
  });
});

describe("splitMetricItems", () => {
  const daily = [
    { label: "実績", value: "¥238,400" },
    { label: "予算", value: "¥260,000" },
    { label: "予算比", value: "91.7%", ratio: 0.917 },
    { label: "件数", value: "42件" },
    { label: "入店数", value: "310人" },
    { label: "月実績", value: "¥3,000,000" },
    { label: "達成率", value: "50.0%", ratio: 0.5 },
  ];
  it("日次: 実績を大きく、予算・予算比を上へ、残りはそのままの順", () => {
    const r = splitMetricItems(daily);
    assert.equal(r.hero.value, "¥238,400");
    assert.equal(r.budget.value, "¥260,000");
    assert.deepEqual(r.ratio, { label: "予算比", value: "91.7%", tone: "critical" });
    assert.deepEqual(r.cells.map((c) => c.label), ["件数", "入店数", "月実績", "達成率"]);
  });
  it("達成なら success", () => {
    const r = splitMetricItems([{ label: "実績", value: "x" }, { label: "予算比", value: "107%", ratio: 1.07 }]);
    assert.equal(r.ratio.tone, "success");
  });
  it("月次: 月実績・月予算・達成率", () => {
    const r = splitMetricItems([
      { label: "月実績", value: "a" },
      { label: "月予算", value: "b" },
      { label: "達成率", value: "c", ratio: 1 },
      { label: "件数", value: "d" },
    ]);
    assert.equal(r.hero.value, "a");
    assert.equal(r.budget.value, "b");
    assert.equal(r.ratio.tone, "success");
    assert.deepEqual(r.cells.map((c) => c.label), ["件数"]);
  });
  it("実績を OFF にしたら、予算・予算比は表の中に残す（項目が消えない）", () => {
    const items = [{ label: "予算", value: "b" }, { label: "予算比", value: "c", ratio: 1 }, { label: "件数", value: "d" }];
    const r = splitMetricItems(items);
    assert.equal(r.hero, null);
    assert.equal(r.ratio, null);
    assert.deepEqual(r.cells, items);
  });
  it("どの項目も落とさない", () => {
    const r = splitMetricItems(daily);
    const shown = [r.hero, r.budget, r.ratio && daily[2], ...r.cells].filter(Boolean).length;
    assert.equal(shown, daily.length);
  });
});

describe("chunkRows", () => {
  it("3 つずつ", () => {
    assert.deepEqual(chunkRows([1, 2, 3, 4]), [[1, 2, 3], [4]]);
    assert.deepEqual(chunkRows([]), []);
  });
});
