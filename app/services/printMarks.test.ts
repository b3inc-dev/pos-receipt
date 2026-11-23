import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  DEFAULT_PRINT_MARK_SETTINGS,
  applyPrintMarksToLayoutHtml,
  insertPrintMarkAtTop,
  layoutPlacesPrintMarks,
  normalizePrintMarkSettings,
  printMarkTemplateValues,
  printMarksFor,
  printRecordTargetId,
} from "./printMarks";
import {
  buildSettlementPrintSnapshot,
  encodePaymentSectionsJson,
  isResettlementRow,
  parsePaymentSectionsJson,
} from "./settlementPrintSnapshot.server";
import { defaultLayout, ciaraSettlementLayout } from "./receiptLayoutPresets";
import { renderReceiptLayout } from "./receiptLayoutRender";
import { sampleTemplateData } from "./receiptLayoutData";
import { normalizeLayout } from "./receiptLayoutValidate";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

const ALL_ON = normalizePrintMarkSettings({
  settlementReprint: true,
  receiptReprint: true,
  salesReprint: true,
  resettlement: true,
});

describe("再印字・再精算の印: 設定", () => {
  it("初期値は全部オフ（今までの印字のまま）", () => {
    assert.deepEqual(normalizePrintMarkSettings(null), DEFAULT_PRINT_MARK_SETTINGS);
    assert.deepEqual(printMarksFor("settlement", { isReprint: true, isResettlement: true }, DEFAULT_PRINT_MARK_SETTINGS), []);
    assert.deepEqual(printMarksFor("receipt", { isReprint: true }, DEFAULT_PRINT_MARK_SETTINGS), []);
    assert.deepEqual(printMarksFor("sales", { isReprint: true }, DEFAULT_PRINT_MARK_SETTINGS), []);
  });

  it("文言は空なら既定・改行を除き・20 文字まで", () => {
    const s = normalizePrintMarkSettings({ reprintText: "  ", resettlementText: "再\n精算です" + "あ".repeat(30) });
    assert.equal(s.reprintText, "再印字");
    assert.equal(s.resettlementText.includes("\n"), false);
    assert.equal(s.resettlementText.length, 20);
    // true 以外はオフ
    assert.equal(normalizePrintMarkSettings({ settlementReprint: "true" }).settlementReprint, false);
  });
});

describe("再印字・再精算の印: どの印刷に出すか", () => {
  it("1 回目の印刷には出さない", () => {
    assert.deepEqual(printMarksFor("settlement", { isReprint: false }, ALL_ON), []);
    assert.deepEqual(printMarksFor("receipt", { isReprint: false }, ALL_ON), []);
    assert.deepEqual(printMarksFor("gift", { isReprint: false }, ALL_ON), []);
  });

  it("2 回目からは再印字。種類ごとにオン／オフ", () => {
    assert.deepEqual(printMarksFor("settlement", { isReprint: true }, ALL_ON), ["再印字"]);
    const onlyReceipt = normalizePrintMarkSettings({ receiptReprint: true, reprintText: "控え" });
    assert.deepEqual(printMarksFor("receipt", { isReprint: true }, onlyReceipt), ["控え"]);
    assert.deepEqual(printMarksFor("settlement", { isReprint: true }, onlyReceipt), []);
    assert.deepEqual(printMarksFor("sales", { isReprint: true }, onlyReceipt), []);
    const onlySales = normalizePrintMarkSettings({ salesReprint: true });
    assert.deepEqual(printMarksFor("gift", { isReprint: true }, onlySales), ["再印字"]);
  });

  it("再精算は 1 回目の印刷から出し、印刷し直すと 再精算・再印字", () => {
    assert.deepEqual(printMarksFor("settlement", { isReprint: false, isResettlement: true }, ALL_ON), ["再精算"]);
    assert.deepEqual(printMarksFor("settlement", { isReprint: true, isResettlement: true }, ALL_ON), ["再精算", "再印字"]);
    // 再精算は精算だけ
    assert.deepEqual(printMarksFor("receipt", { isReprint: false, isResettlement: true }, ALL_ON), []);
  });

  it("点検レシートには何も出さない（T 2026-11-24）", () => {
    assert.deepEqual(printMarksFor("settlement", { isReprint: true, isResettlement: true, isInspection: true }, ALL_ON), []);
  });

  it("販売・ギフトの注文 id は gid でも数字でも同じ記録", () => {
    assert.equal(printRecordTargetId("sales", "gid://shopify/Order/123"), "123");
    assert.equal(printRecordTargetId("gift", "123"), "123");
    assert.equal(printRecordTargetId("receipt", "cl_abc"), "cl_abc");
  });
});

describe("再印字・再精算の印: HTML", () => {
  it("<body> のすぐ後ろに四角で囲んで出し、文言はエスケープする", () => {
    const html = insertPrintMarkAtTop('<html><body class="x"><h1>T</h1></body></html>', ["<再>", "再印字"]);
    assert.match(html, /<body class="x"><div class="print-mark"[^>]*><span[^>]*>&lt;再&gt;・再印字<\/span><\/div><h1>/);
  });

  it("印が無ければ HTML は変えない", () => {
    const html = "<html><body><h1>T</h1></body></html>";
    assert.equal(insertPrintMarkAtTop(html, []), html);
  });

  it("レイアウトに印のブロックがあれば、上には足さない（ブロックの場所に出る）", () => {
    const base = defaultLayout("settlement");
    assert.equal(layoutPlacesPrintMarks(base), false);
    const withBlock = normalizeLayout(
      { ...base, blocks: [{ id: "m1", type: "print_marks", settings: {} }, ...base.blocks] },
      "settlement",
    );
    assert.equal(layoutPlacesPrintMarks(withBlock), true);
    const hidden = { ...withBlock, blocks: withBlock.blocks.map((b) => (b.type === "print_marks" ? { ...b, hidden: true } : b)) };
    assert.equal(layoutPlacesPrintMarks(hidden), false);
    assert.equal(layoutPlacesPrintMarks({ mode: "code", blocks: [], code: "{{ print_mark_text }}" }), true);
    assert.equal(layoutPlacesPrintMarks({ mode: "code", blocks: [], code: "{{ settlement.total }}" }), false);
  });

  it("印のブロックは、印があるときだけ出る", () => {
    const base = ciaraSettlementLayout();
    const layout = normalizeLayout(
      { ...base, blocks: [...base.blocks.slice(0, 1), { id: "m1", type: "print_marks", settings: {} }, ...base.blocks.slice(1)] },
      "settlement",
    );
    const data = sampleTemplateData("settlement") as unknown as Record<string, unknown>;
    const on = renderReceiptLayout(layout, { ...data, ...printMarkTemplateValues(["再精算", "再印字"], true) });
    assert.equal(on.ok, true);
    if (on.ok) assert.match(on.html, /再精算・再印字/);
    const off = renderReceiptLayout(layout, { ...data, ...printMarkTemplateValues([], false) });
    assert.equal(off.ok, true);
    if (off.ok) assert.doesNotMatch(off.html, /再印字/);
    // ブロックがあれば上には足さない
    if (on.ok) {
      const out = applyPrintMarksToLayoutHtml(on.html, layout, ["再印字"]);
      assert.equal(out, on.html);
    }
  });

  it("印のブロックは領収書には出さない（発行したときの領収書の上に足す）", async () => {
    const { blockDefsForKind } = await import("./receiptLayoutBlocks");
    assert.equal(blockDefsForKind("receipt").some((d) => d.type === "print_marks"), false);
    for (const k of ["settlement", "sales", "gift"] as const) {
      assert.equal(blockDefsForKind(k).some((d) => d.type === "print_marks"), true, k);
    }
  });
});

describe("再精算の記録", () => {
  it("再確定でできた精算だけ snapshot に resettlement が残る（点検・古い記録は false）", () => {
    const re = buildSettlementPrintSnapshot({ locationName: "梅田店", isInspection: false, isResettlement: true });
    const json = encodePaymentSectionsJson([], re);
    assert.equal(parsePaymentSectionsJson(json).snapshot?.resettlement, true);
    assert.equal(isResettlementRow({ paymentSectionsJson: json }), true);

    const first = buildSettlementPrintSnapshot({ locationName: "梅田店", isInspection: false });
    assert.equal(isResettlementRow({ paymentSectionsJson: encodePaymentSectionsJson([], first) }), false);

    const insp = buildSettlementPrintSnapshot({ locationName: "梅田店", isInspection: true, isResettlement: true });
    assert.equal(insp.resettlement, undefined);

    assert.equal(isResettlementRow({ paymentSectionsJson: "[]" }), false);
    assert.equal(isResettlementRow({ paymentSectionsJson: null }), false);
  });

  it("精算の確定は再確定のときだけ isResettlement を渡す（数え方は変えない）", () => {
    const create = src("app/routes/api.settlements.create.tsx");
    assert.match(create, /isResettlement: !inspection && !!raced/);
  });
});

describe("印字の道につながっている", () => {
  it("精算は printedAt で再印字を見分け、点検を渡す", () => {
    const s = src("app/routes/api.print.settlement.$id.tsx");
    assert.match(s, /isReprint = settlement\.printedAt != null/);
    assert.match(s, /isInspection \}/);
    assert.match(s, /insertPrintMarkAtTop\(reprint\.html, printMarks\)/);
    assert.match(s, /applyPrintMarksToLayoutHtml\(html, layout, printMarks\)/);
  });

  it("領収書・販売・ギフトは PrintRecord で見分ける", () => {
    assert.match(src("app/routes/api.print.receipt.$id.tsx"), /wasPrinted\(shop\.id, "receipt", issued\.id\)/);
    const sales = src("app/routes/api.print.sales.$orderId.tsx");
    assert.match(sales, /wasPrinted\(shop\.id, layoutKind, gid\)/);
    assert.equal((sales.match(/insertPrintMarkAtTop\(/g) ?? []).length, 2);
  });

  it("POS は印刷を受け付けたあとだけ記録する", () => {
    const p = src("extensions/common/printApi.js");
    assert.match(p, /if \(res\?\.ok\) await markReceiptPrinted\(options\.gift \? "gift" : "sales", id\)/);
    assert.match(p, /if \(res\?\.ok\) await markReceiptPrinted\("receipt", receiptIssueId\)/);
  });

  it("migration は新しい表を足すだけ", () => {
    const sql = src("prisma/migrations/20261124120000_print_record/migration.sql");
    assert.match(sql, /CREATE TABLE "PrintRecord"/);
    assert.doesNotMatch(sql, /ALTER TABLE "(?!PrintRecord)/);
    assert.doesNotMatch(sql, /DROP /);
  });
});
