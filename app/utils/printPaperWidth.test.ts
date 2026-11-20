/**
 * 印字用紙幅の中立キー（paperWidthMm）とレガシー cloudprntPaperWidth 同期
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolvePrintPaperWidthMm,
  syncPrintPaperWidthFields,
} from "./printPaperWidth";

describe("resolvePrintPaperWidthMm / syncPrintPaperWidthFields", () => {
  it("paperWidthMm を優先する", () => {
    assert.equal(resolvePrintPaperWidthMm({ paperWidthMm: 58, cloudprntPaperWidth: "80mm" }), 58);
  });

  it("未設定時は cloudprntPaperWidth にフォールバック", () => {
    assert.equal(resolvePrintPaperWidthMm({ cloudprntPaperWidth: "58mm" }), 58);
    assert.equal(resolvePrintPaperWidthMm({}), 80);
  });

  it("同期ヘルパーは両キーを揃える", () => {
    assert.deepEqual(syncPrintPaperWidthFields(58), {
      paperWidthMm: 58,
      cloudprntPaperWidth: "58mm",
    });
    assert.deepEqual(syncPrintPaperWidthFields(80), {
      paperWidthMm: 80,
      cloudprntPaperWidth: "80mm",
    });
  });
});
