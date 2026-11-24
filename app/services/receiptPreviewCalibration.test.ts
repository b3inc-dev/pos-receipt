import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLayout } from "./receiptLayoutPresets";
import { canonicalLayout, defaultPaperPrintStyle, RECEIPT_KINDS } from "./receiptLayoutSchema";
import { blocksToCode, paperWidthPx, previewViewportPx, renderReceiptLayout } from "./receiptLayoutRender";
import { normalizeLayout, validateLayoutInput } from "./receiptLayoutValidate";
import { sampleTemplateData } from "./receiptLayoutData";

test("mPOP実測100px=12mmから400pxで折り返しを計算する。未補正幅と80mmを混同しない", () => {
  const layout = { ...defaultLayout("settlement"), paperWidthMm: 58 as const, previewCalibration: { 58: 12 } };
  assert.equal(previewViewportPx(layout), 400);
  assert.equal(previewViewportPx({ ...layout, paperWidthMm: 80 }), paperWidthPx(80));
  assert.equal(previewViewportPx({ paperWidthMm: 58 }), paperWidthPx(58));
  assert.equal(previewViewportPx({ paperWidthMm: 80, previewCalibration: { 80: 12 } }), 600);
});

test("プレビュー補正は保存/再読込で保持し、印字HTML・文字サイズ・金額を変えない", () => {
  for (const kind of RECEIPT_KINDS) {
    const layout = { ...defaultLayout(kind), previewCalibration: { 58: 12, 80: 15 } };
    const saved = validateLayoutInput(layout, kind);
    assert.ok(saved.ok);
    assert.equal(JSON.stringify(normalizeLayout(saved.layout, kind)), JSON.stringify(canonicalLayout(layout)));
    assert.equal(renderReceiptLayout(layout, sampleTemplateData(kind)).html,
      renderReceiptLayout({ ...layout, previewCalibration: undefined }, sampleTemplateData(kind)).html);
  }
});

test("壊れた補正値を保存せず、既存店へ推測の機種別倍率を適用しない", () => {
  for (const v of [0, -1, 100, NaN, "12"]) {
    const layout = { ...defaultLayout("sales"), previewCalibration: { 58: v } };
    assert.equal(validateLayoutInput(layout, "sales").ok, false);
    assert.equal(normalizeLayout(layout, "sales").previewCalibration, undefined);
  }
  assert.equal(normalizeLayout(defaultLayout("sales"), "sales").previewCalibration, undefined);
});

test("ブロックと新生成Liquidは全幅・用紙別のロゴ割合・18ptを共通反映する", () => {
  for (const kind of RECEIPT_KINDS) for (const mm of [58, 80] as const) {
    const layout = { ...defaultLayout(kind), paperWidthMm: mm,
      paperStyles: { [mm]: { ...defaultPaperPrintStyle(mm), fontSizePt: 18, amountFontSizePt: 18 } } };
    const blockResult = renderReceiptLayout(layout, sampleTemplateData(kind));
    const codeResult = renderReceiptLayout({ ...layout, mode: "code", code: blocksToCode(layout) }, sampleTemplateData(kind));
    assert.ok(blockResult.ok && codeResult.ok);
    assert.equal(blockResult.html, codeResult.html);
    assert.match(blockResult.html, /width:100%;max-width:100%/);
    assert.match(blockResult.html, /font-size:18pt/);
    assert.match(blockResult.html, mm === 58 ? /max-width:62\.5%/ : /max-width:50%/);
    assert.doesNotMatch(blockResult.html, /width:(48|72)mm/);
  }
});

test("手書きLiquidの幅・ロゴ・文字指定は無断書換しない", () => {
  const code = '<style>body{width:70%;font-size:20pt}.logo{width:60%}</style><p>{{ shop.name }}</p>';
  const result = renderReceiptLayout({ ...defaultLayout("settlement"), mode: "code", code }, sampleTemplateData("settlement"));
  assert.ok(result.ok);
  assert.ok(result.html.startsWith('<style>body{width:70%;font-size:20pt}.logo{width:60%}</style>'));
});
