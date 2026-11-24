import assert from "node:assert/strict";
import { test } from "node:test";
import { baseCss, paperWidthPx } from "./receiptLayoutRender";
import { DEFAULT_LAYOUT_STYLE } from "./receiptLayoutSchema";

test("receipt layout uses physical printable width, not printer dot count", () => {
  const narrow = baseCss({ paperWidthMm: 58, style: DEFAULT_LAYOUT_STYLE });
  const wide = baseCss({ paperWidthMm: 80, style: DEFAULT_LAYOUT_STYLE });
  assert.equal(paperWidthPx(58), 181);
  assert.equal(paperWidthPx(80), 272);
  assert.match(narrow, /width:48mm;max-width:100%/);
  assert.match(wide, /width:72mm;max-width:100%/);
  for (const css of [narrow, wide]) {
    assert.match(css, /font-size:13px/);
    assert.match(css, /overflow-wrap:anywhere/);
    assert.match(css, /box-sizing:border-box/);
    assert.doesNotMatch(css, /width:(384|576)px/);
  }
});
