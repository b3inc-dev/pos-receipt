import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BLOCK_DEFS, defaultSettings } from "./receiptLayoutBlocks";
import { sampleTemplateData } from "./receiptLayoutData";
import { defaultLayout } from "./receiptLayoutPresets";
import { blocksToCode, renderReceiptLayout } from "./receiptLayoutRender";
import { defaultPaperPrintStyle, type ReceiptLayout } from "./receiptLayoutSchema";

function render(layout: ReceiptLayout): string {
  const result = renderReceiptLayout(layout, sampleTemplateData(layout.kind));
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.html;
}

describe("合計ブロックと用紙別の文字設定の優先順位", () => {
  for (const paperWidthMm of [58, 80] as const) {
    for (const mode of ["blocks", "code"] as const) {
      it(`${paperWidthMm}mm/${mode}: 販売合計のサイズ選択と太字OFFを維持する`, () => {
        const def = BLOCK_DEFS.find((block) => block.type === "totals")!;
        for (const [size, scale] of [["s", ".85"], ["m", "1"], ["l", "1.3"], ["xl", "1.8"]]) {
          const layout: ReceiptLayout = {
            ...defaultLayout("sales"),
            paperWidthMm,
            paperStyles: { [paperWidthMm]: { ...defaultPaperPrintStyle(paperWidthMm), amountFontSizePt: 16 } },
            blocks: [{ id: "total", type: "totals", settings: { ...defaultSettings(def), total_size: size, total_bold: false } }],
          };
          if (mode === "code") {
            layout.code = blocksToCode(layout);
            layout.mode = "code";
          }
          const html = render(layout);
          assert.ok(html.includes(`<div class="row fs-${size}"><span>合計</span><span class="print-value print-total">`));
          assert.ok(html.includes(`--receipt-font-scale:${scale}}`));
          const totalRule = html.match(/\.print-total,\.row \.print-total\{([^}]+)\}/)?.[1] ?? "";
          assert.ok(totalRule.includes("calc(max(14pt,16pt) * var(--receipt-font-scale,1.3) / 1.3)"), totalRule);
          assert.ok(!totalRule.includes("font-weight"), "太字を強制するとtotal_bold=falseが効かなくなる");
          layout.mode = "blocks";
          layout.blocks[0].settings.total_bold = true;
          if (mode === "code") {
            layout.code = blocksToCode(layout);
            layout.mode = "code";
          }
          assert.ok(render(layout).includes(`<div class="row fs-${size} b"><span>合計</span>`));
        }
      });

      it(`${paperWidthMm}mm/${mode}: 領収金額自身のサイズと太字を保持する`, () => {
        const def = BLOCK_DEFS.find((block) => block.type === "receipt_amount")!;
        const layout: ReceiptLayout = {
          ...defaultLayout("receipt"),
          paperWidthMm,
          paperStyles: { [paperWidthMm]: defaultPaperPrintStyle(paperWidthMm) },
          blocks: [{ id: "amount", type: "receipt_amount", settings: { ...defaultSettings(def), size: "xl" } }],
        };
        if (mode === "code") {
          layout.code = blocksToCode(layout);
          layout.mode = "code";
        }
        const html = render(layout);
        assert.match(html, /class="blk print-total [^"]*fs-xl b /);
        assert.ok(html.includes("--receipt-font-scale:1.8"));
        assert.ok(html.includes(".b{font-weight:700}"));
      });
    }
  }
});

describe("金額・件数設定は各帳票の数値要素に届く", () => {
  for (const paperWidthMm of [58, 80] as const) {
    for (const mode of ["blocks", "code"] as const) {
      it(`${paperWidthMm}mm/${mode}: 領収書内訳・販売の数量単価・ギフト数量にも適用`, () => {
        for (const kind of ["receipt", "sales", "gift", "settlement"] as const) {
          const layout: ReceiptLayout = {
            ...defaultLayout(kind), paperWidthMm,
            paperStyles: { [paperWidthMm]: { ...defaultPaperPrintStyle(paperWidthMm), fontSizePt: 10, amountFontSizePt: 20 } },
          };
          if (mode === "code") {
            layout.code = blocksToCode(layout);
            layout.mode = "code";
          }
          const html = render(layout);
          assert.ok(html.includes(".print-value,.row .print-value{font-size:20pt}"));
          if (kind === "receipt") {
            assert.match(html, /消費税 \(10%\)：<span class="print-value">¥450<\/span>/);
            assert.match(html, /現金：<span class="print-value">¥4,950<\/span>/);
          } else if (kind === "sales") {
            assert.match(html, /<div class="print-value">2 x ¥2,200<\/div>/);
          } else if (kind === "gift") {
            assert.match(html, /<span class="print-value">×2<\/span>/);
          } else {
            assert.match(html, /<span class="print-value">42件<\/span>/);
            assert.match(html, /現金 \(<span class="print-value">18件<\/span>\)/);
            assert.match(html, /うち返金 <span class="print-value">1件<\/span>/);
          }
        }
      });
    }
  }
});

describe("推奨初期値の合計サイズ", () => {
  for (const paperWidthMm of [58, 80] as const) {
    for (const kind of ["sales", "receipt"] as const) {
      it(`${paperWidthMm}mm/${kind}: 既定lは14pt基準で、サイズ変更の相対比を保持する`, () => {
        const layout: ReceiptLayout = {
          ...defaultLayout(kind), paperWidthMm,
          paperStyles: { [paperWidthMm]: defaultPaperPrintStyle(paperWidthMm) },
        };
        const total = layout.blocks.find((block) => block.type === (kind === "sales" ? "totals" : "receipt_amount"))!;
        assert.equal(total.settings[kind === "sales" ? "total_size" : "size"], "l");
        const html = render(layout);
        assert.ok(html.includes("calc(max(14pt,11pt) * var(--receipt-font-scale,1.3) / 1.3)"));
        assert.ok(html.includes(".fs-l{font-size:1.3em;--receipt-font-scale:1.3}"));
        assert.ok(html.includes(".fs-xl{font-size:1.8em;--receipt-font-scale:1.8}"));
      });
    }
  }
});
