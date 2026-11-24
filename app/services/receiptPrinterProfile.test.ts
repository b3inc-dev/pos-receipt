import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { applyPrinterProfile, normalizePrinterProfile, printerGeometry } from "./receiptPrinterProfile";
import { defaultLayout } from "./receiptLayoutPresets";
import { RECEIPT_KINDS } from "./receiptLayoutSchema";
import { blocksToCode, renderReceiptLayout } from "./receiptLayoutRender";
import { sampleTemplateData } from "./receiptLayoutData";
import { withPrintCsp } from "./receiptLayoutPrint.server";

const documentHtml = '<!DOCTYPE html><html><head><style>body{width:48mm}</style></head><body><p>合計 ¥50,754</p><div class="row">右 R 100%</div></body></html>';
test("既存店・不明な設定・mPOP・80mmは送信HTMLを変えない", () => {
  for (const value of [undefined, null, "unknown", "standard", "mpop_58"]) {
    assert.equal(applyPrinterProfile(documentHtml, value, 58), documentHtml);
  }
  assert.equal(normalizePrinterProfile({}), "standard");
  assert.equal(applyPrinterProfile(documentHtml, "mcp31lb_58", 80), documentHtml);
  assert.equal(printerGeometry("mcp31lb_58", 80).viewportPx, undefined);
});
test("MCP診断Bと同じ横1.5倍・配置64%を一度だけ適用し、中身/金額/CSPを保持", () => {
  const source = withPrintCsp(documentHtml);
  const result = applyPrinterProfile(source, "mcp31lb_58", 58);
  const doc = new JSDOM(result).window.document;
  assert.match(result, /width:64%!important/);
  assert.match(result, /transform:scaleX\(1\.5\)!important/);
  assert.equal(doc.querySelectorAll('[data-receipt-printer-content]').length, 1);
  assert.equal(doc.querySelector('[data-receipt-printer-content]')?.textContent, '合計 ¥50,754右 R 100%');
  assert.ok(doc.querySelector('meta[http-equiv="Content-Security-Policy"]'));
  assert.equal(applyPrinterProfile(result, "mcp31lb_58", 58), result);
  assert.ok(source.includes('合計 ¥50,754')); // 保存元は加工しない
});
test("全4帳票のブロック/生成コード/手書き断片が同じ補正を使う", () => {
  for (const kind of RECEIPT_KINDS) for (const mode of ["blocks", "code"] as const) {
    const layout = { ...defaultLayout(kind), paperWidthMm: 58 as const, mode };
    layout.code = blocksToCode(layout);
    const rendered = renderReceiptLayout(layout, sampleTemplateData(kind));
    assert.ok(rendered.ok);
    const result = applyPrinterProfile(rendered.html, "mcp31lb_58", 58);
    const doc = new JSDOM(result).window.document;
    assert.equal(doc.querySelectorAll('[data-receipt-printer-content]').length, 1);
    assert.equal(doc.querySelector('[data-receipt-printer-content]')?.textContent?.replace(/\s+/g, ''), new JSDOM(rendered.html).window.document.body.textContent?.replace(/\s+/g, ''));
  }
  const fragment = '<style>.logo{width:60%}</style><p>合計 ¥35</p>';
  const doc = new JSDOM(applyPrinterProfile(fragment, "mcp31lb_58", 58)).window.document;
  assert.equal(doc.querySelector('[data-receipt-printer-content] p')?.textContent, '合計 ¥35');
});
test("既存の診断B補正を重ねない", () => {
  const existing = '<html><body><div class="mcp-correction">診断 B</div></body></html>';
  assert.equal(applyPrinterProfile(existing, "mcp31lb_58", 58), existing);
});
test("補正後プレビューは実測の横圧縮を模擬し縦を縮めない。正方形/余白/折返し幅を計算", () => {
  const mcp = printerGeometry("mcp31lb_58", 58);
  const mpop = printerGeometry("mpop_58", 58);
  assert.equal(mpop.viewportPx, 400);
  assert.equal(mcp.viewportPx, 600);
  assert.equal(100 * 1.5 * mcp.horizontalScale, 100); // x100pxがy100pxと同じになる
  assert.equal(mcp.viewportPx! * .64, 384); // レイアウトの折り返しは384px
  assert.equal(.64 * 1.5, .96); // 紙右端に4%を残す
  assert.equal(mcp.viewportPx! * mcp.horizontalScale, 400); // 外側はmPOPと同じ実測尺度
});
