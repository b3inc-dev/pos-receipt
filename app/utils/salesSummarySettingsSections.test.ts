import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SALES_SUMMARY_SETTINGS } from "./appSettings.server";
import { isSectionKey, readSectionForm, sectionSummary, SECTION_ORDER } from "./salesSummarySettingsSections";

const locs = [
  { id: "gid://shopify/Location/1", name: "梅田" },
  { id: "gid://shopify/Location/2", name: "心斎橋" },
  { id: "gid://shopify/Location/3", name: "天王寺" },
];
const ids = locs.map((l) => l.id);

function form(entries: [string, string][]) {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

test("区分の保存は、その区分の項目だけを返す（ほかの区分を書き換えない）", () => {
  const out = readSectionForm("numbers", form([["showBudget", "on"], ["loyaltyUsageSummaryLabel", " ポイント "]]), ids);
  assert.equal(out.showBudget, true);
  assert.equal(out.showActual, false);
  assert.equal(out.loyaltyUsageSummaryLabel, "ポイント");
  assert.equal("salesSummaryEnabled" in out, false);
  assert.equal("visibleLocationIds" in out, false);
  const basic = readSectionForm("basic", form([["salesSummaryEnabled", "on"], ["weekStartsOn", "sunday"]]), ids);
  assert.deepEqual(Object.keys(basic).sort(), ["allowDateRangeSummary", "allowSingleDateSummary", "salesSummaryEnabled", "weekStartsOn"]);
  assert.equal(basic.weekStartsOn, "sunday");
});

test("店の選択: 全部選んだら空（すべての店）、知らない id は捨てる", () => {
  const all = readSectionForm("display", form(ids.map((id) => ["visibleLocationIds", id])), ids);
  assert.deepEqual(all.visibleLocationIds, []);
  const some = readSectionForm("footfall", form([["footfallTargetLocationIds", ids[0]], ["footfallTargetLocationIds", "gid://shopify/Location/99"], ["footfallReportingEnabled", "on"]]), ids);
  assert.deepEqual(some.footfallTargetLocationIds, [ids[0]]);
  assert.equal(some.footfallReportingEnabled, true);
  assert.equal(some.footfallReportRequiresConfirmation, false);
});

test("ポイント利用額の名前が空なら元の名前", () => {
  assert.equal(readSectionForm("numbers", form([["loyaltyUsageSummaryLabel", "  "]]), ids).loyaltyUsageSummaryLabel, "ポイント利用額");
});

test("要約の行は今の設定を店の言葉で 1 行にする", () => {
  const s = { ...DEFAULT_SALES_SUMMARY_SETTINGS };
  const link = { active: false, passwordSet: false };
  assert.equal(sectionSummary("basic", s, locs, link), "使う・1日と期間で見られる・週は月曜始まり");
  assert.match(sectionSummary("display", s, locs, link), /出す店: すべての店（3 店）$/);
  assert.equal(sectionSummary("numbers", s, locs, link), "すべて出す（16 個）");
  assert.equal(sectionSummary("footfall", { ...s, footfallTargetLocationIds: [ids[1]] }, locs, link), "報告する・心斎橋・送る前に確かめる");
  assert.equal(sectionSummary("link", s, locs, link), "まだ発行していません");
  assert.equal(sectionSummary("basic", { ...s, salesSummaryEnabled: false }, locs, link), "使わない");
  for (const key of SECTION_ORDER) {
    assert.equal(/[a-z]{3,}/i.test(sectionSummary(key, s, locs, { active: true, passwordSet: true })), false, `${key} に英字のキーが出ている`);
  }
});

test("区分の名前を確かめる", () => {
  assert.equal(isSectionKey("numbers"), true);
  assert.equal(isSectionKey("settings"), false);
  assert.equal(isSectionKey(undefined), false);
});
