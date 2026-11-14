import assert from "node:assert/strict";
import test from "node:test";
import {
  paperStripPercent,
  paperWidthUses,
  parseSalesPaperWidth,
  parseSharedPaperWidth,
} from "./paperWidthCorrespondence";

test("印字設定と販売レシートの用紙幅は別々に読む", () => {
  assert.equal(parseSharedPaperWidth("58mm"), 58);
  assert.equal(parseSharedPaperWidth("80mm"), 80);
  assert.equal(parseSharedPaperWidth("wide"), 80);
  assert.equal(parseSalesPaperWidth(58), 58);
  assert.equal(parseSalesPaperWidth(80), 80);

  const rows = paperWidthUses({ sharedWidthMm: 58, salesWidthMm: 80 });
  assert.deepEqual(
    rows.map((row) => [row.document, row.widthMm, row.shared]),
    [
      ["精算", 58, true],
      ["点検", 58, true],
      ["領収書", 58, true],
      ["販売レシート", 80, false],
    ],
  );
  assert.equal(rows[0].settingName, rows[2].settingName);
  assert.notEqual(rows[3].settingName, rows[0].settingName);
  assert.equal(paperStripPercent(58), 72.5);
  assert.equal(paperStripPercent(80), 100);
});
