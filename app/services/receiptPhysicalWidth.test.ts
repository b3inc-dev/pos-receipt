import assert from "node:assert/strict";
import { test } from "node:test";
import { baseCss, paperWidthPx, blocksToCode, renderReceiptLayout } from "./receiptLayoutRender";
import { DEFAULT_LAYOUT_STYLE, defaultPaperPrintStyle, canonicalLayout, RECEIPT_KINDS } from "./receiptLayoutSchema";

test("receipt layout fills the printer viewport without assuming its dot count", () => {
  const narrow = baseCss({ paperWidthMm: 58, style: DEFAULT_LAYOUT_STYLE });
  const wide = baseCss({ paperWidthMm: 80, style: DEFAULT_LAYOUT_STYLE });
  assert.equal(paperWidthPx(58), 181);
  assert.equal(paperWidthPx(80), 272);
  assert.match(narrow, /width:100%;max-width:100%/);
  assert.match(wide, /width:100%;max-width:100%/);
  for (const css of [narrow, wide]) {
    assert.match(css, /font-size:13px/);
    assert.match(css, /overflow-wrap:anywhere/);
    assert.match(css, /box-sizing:border-box/);
    assert.doesNotMatch(css, /width:(384|576)px/);
  }
});

import { defaultLayout } from "./receiptLayoutPresets";
import { normalizeLayout, validateLayoutInput } from "./receiptLayoutValidate";
import { sampleTemplateData } from "./receiptLayoutData";

test("each receipt retains both paper profiles through validation and storage", () => {
  for (const kind of RECEIPT_KINDS) {
    const layout = {
      ...defaultLayout(kind),
      paperStyles: {
        58: { ...defaultPaperPrintStyle(58), fontSizePt: 12, amountFontSizePt: 13 },
        80: { ...defaultPaperPrintStyle(80), fontSizePt: 11, amountFontSizePt: 12 },
      },
    };
    const input = JSON.parse(JSON.stringify(canonicalLayout(layout)));
    const valid = validateLayoutInput(input, kind);
    assert.ok(valid.ok, kind);
    assert.deepEqual(normalizeLayout(valid.layout, kind).paperStyles, layout.paperStyles);
    for (const width of [58, 80] as const) {
      const result = renderReceiptLayout({ ...valid.layout, paperWidthMm: width }, sampleTemplateData(kind));
      assert.ok(result.ok, kind);
      assert.ok(result.html.includes(`font-size:${layout.paperStyles[width].fontSizePt}pt`));
      assert.ok(result.html.includes("width:100%;max-width:100%"));
      assert.ok(result.html.includes(`font-size:${layout.paperStyles[width].amountFontSizePt}pt`));
      assert.ok(result.html.includes(`padding:3mm ${width === 58 ? 1 : 1.5}mm`));
      assert.doesNotMatch(result.html, /transform\s*:\s*scale/);
    }
    const code = { ...layout, mode: "code" as const, code: blocksToCode({ ...layout, paperWidthMm: 80 }) };
    const narrow = renderReceiptLayout({ ...code, paperWidthMm: 58 }, sampleTemplateData(kind));
    assert.ok(narrow.ok);
    assert.match(narrow.html, /width:100%;max-width:100%/);
    assert.match(narrow.html, /font-size:12pt/);
  }
});

test("invalid paper profile is rejected", () => {
  const layout = { ...defaultLayout("settlement"), paperStyles: { 58: { ...defaultPaperPrintStyle(58), marginXMm: 20 } } };
  assert.equal(validateLayoutInput(layout, "settlement").ok, false);
});
