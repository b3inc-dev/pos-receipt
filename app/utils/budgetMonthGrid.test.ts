import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addMonths,
  budgetToInput,
  diffBudgetMonth,
  isMonthKey,
  monthChoices,
  monthDays,
  normalizeDateInput,
  parseBudgetInput,
  sumBudgetMonth,
} from "./budgetMonthGrid";

describe("monthDays", () => {
  it("1 日〜月末を曜日つきで並べる（2026-11 は 30 日、11/1 は日曜）", () => {
    const days = monthDays("2026-11");
    assert.equal(days.length, 30);
    assert.deepEqual(days[0], { date: "2026-11-01", day: 1, weekday: 0, weekdayLabel: "日" });
    assert.equal(days[22].date, "2026-11-23");
    assert.equal(days[22].weekdayLabel, "月");
    assert.equal(days[29].date, "2026-11-30");
  });
  it("うるう年の 2 月は 29 日", () => {
    assert.equal(monthDays("2028-02").length, 29);
    assert.equal(monthDays("2027-02").length, 28);
  });
  it("月でない文字は空", () => {
    assert.deepEqual(monthDays("2026-13"), []);
    assert.deepEqual(monthDays("abc"), []);
    assert.equal(isMonthKey("2026-00"), false);
  });
});

describe("addMonths / monthChoices", () => {
  it("年をまたいで足し引きする", () => {
    assert.equal(addMonths("2026-11", 2), "2027-01");
    assert.equal(addMonths("2026-01", -1), "2025-12");
  });
  it("前後 12 か月を並べる", () => {
    const list = monthChoices("2026-11");
    assert.equal(list.length, 25);
    assert.equal(list[0], "2025-11");
    assert.equal(list[24], "2027-11");
  });
});

describe("parseBudgetInput", () => {
  it("空欄は予算なし", () => {
    assert.deepEqual(parseBudgetInput(""), { ok: true, value: null });
    assert.deepEqual(parseBudgetInput("  "), { ok: true, value: null });
  });
  it("¥・カンマ・円・全角数字を受け付ける", () => {
    assert.deepEqual(parseBudgetInput("¥120,000"), { ok: true, value: 120000 });
    assert.deepEqual(parseBudgetInput("１２０，０００円"), { ok: true, value: 120000 });
    assert.deepEqual(parseBudgetInput("0"), { ok: true, value: 0 });
    assert.deepEqual(parseBudgetInput("1500.5"), { ok: true, value: 1500.5 });
  });
  it("マイナス・文字・小数 3 桁・大きすぎる金額は誤り", () => {
    assert.equal(parseBudgetInput("-100").ok, false);
    assert.equal(parseBudgetInput("12a").ok, false);
    assert.equal(parseBudgetInput("1.234").ok, false);
    assert.equal(parseBudgetInput("1000000000000").ok, false);
  });
});

describe("diffBudgetMonth", () => {
  const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
  it("追加・変更・削除だけを返し、同じ値は返さない", () => {
    const { changes, errors } = diffBudgetMonth(
      days,
      { "2026-11-01": 1000, "2026-11-02": 2000, "2026-11-03": 3000 },
      { "2026-11-01": "1,000", "2026-11-02": "2500", "2026-11-03": "", "2026-11-04": "400" },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(changes, [
      { date: "2026-11-02", before: 2000, after: 2500, kind: "update" },
      { date: "2026-11-03", before: 3000, after: null, kind: "remove" },
      { date: "2026-11-04", before: null, after: 400, kind: "add" },
    ]);
  });
  it("誤りの日は errors に入れ、changes に入れない", () => {
    const { changes, errors } = diffBudgetMonth(days, {}, { "2026-11-01": "abc", "2026-11-02": "10" });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].date, "2026-11-01");
    assert.equal(changes.length, 1);
  });
  it("入力の無い日（送られてこない日）は変えない", () => {
    const { changes } = diffBudgetMonth(days, { "2026-11-01": 1000 }, {});
    assert.deepEqual(changes, []);
  });
});

describe("sumBudgetMonth", () => {
  it("予算なしの日は足さず、日数にも数えない", () => {
    assert.deepEqual(sumBudgetMonth([1000, null, 2000, undefined, 0]), { total: 3000, filledDays: 3 });
  });
});

describe("budgetToInput", () => {
  it("カンマ付きで出し、読み直すと同じ金額になる", () => {
    assert.equal(budgetToInput(1234567), "1,234,567");
    assert.equal(budgetToInput(1500.5), "1,500.5");
    assert.equal(budgetToInput(null), "");
    assert.deepEqual(parseBudgetInput(budgetToInput(1234567.25)), { ok: true, value: 1234567.25 });
  });
});

describe("normalizeDateInput", () => {
  it("2026/11/24・2026-11-24・2026/1/5・2026年11月24日を読む", () => {
    assert.equal(normalizeDateInput("2026/11/24"), "2026-11-24");
    assert.equal(normalizeDateInput("2026-11-24"), "2026-11-24");
    assert.equal(normalizeDateInput(" 2026/1/5 "), "2026-01-05");
    assert.equal(normalizeDateInput("2026年11月24日"), "2026-11-24");
  });
  it("無い日・形の違いは null", () => {
    assert.equal(normalizeDateInput("2026/02/30"), null);
    assert.equal(normalizeDateInput("11/24"), null);
    assert.equal(normalizeDateInput(""), null);
  });
});
