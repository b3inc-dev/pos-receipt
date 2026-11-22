import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BLOCK_DEFS, blockDefsForKind, defaultSettings } from "./receiptLayoutBlocks";
import { sampleTemplateData } from "./receiptLayoutData";
import {
  ciaraReceiptLayout,
  ciaraSalesLayout,
  ciaraSettlementLayout,
  defaultLayout,
  LAYOUT_PRESETS,
} from "./receiptLayoutPresets";
import {
  blocksToCode,
  isSafeImageUrl,
  renderReceiptLayout,
  textSettingToLiquid,
} from "./receiptLayoutRender";
import { RECEIPT_KINDS, type ReceiptLayout } from "./receiptLayoutSchema";
import { normalizeLayout, validateLayoutInput } from "./receiptLayoutValidate";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function html(layout: ReceiptLayout, data: Record<string, unknown> = sampleTemplateData(layout.kind)): string {
  const r = renderReceiptLayout(layout, data);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.html;
}

/** タグを外して空白を 1 つにした本文（見た目の文字の順を比べる） */
function text(h: string): string {
  return h
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<br\/>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("receiptLayout: ブロック定義", () => {
  it("どのブロックも設定の初めの値で 4 種すべてのレシートを描ける", () => {
    for (const kind of RECEIPT_KINDS) {
      for (const def of blockDefsForKind(kind)) {
        const layout: ReceiptLayout = {
          ...defaultLayout(kind),
          blocks: [{ id: "b1", type: def.type, settings: defaultSettings(def) }],
        };
        const r = renderReceiptLayout(layout, sampleTemplateData(kind));
        assert.ok(r.ok, `${kind}/${def.type}: ${r.ok ? "" : r.error}`);
      }
    }
  });

  it("ブロックの type は重ならない", () => {
    assert.equal(new Set(BLOCK_DEFS.map((d) => d.type)).size, BLOCK_DEFS.length);
  });
});

describe("receiptLayout: 描き方", () => {
  it("ブロックで描いた HTML と、コードに変えて描いた HTML は同じ", () => {
    for (const preset of LAYOUT_PRESETS) {
      for (const kind of preset.kinds) {
        const blocks = preset.build(kind);
        const code: ReceiptLayout = { ...blocks, mode: "code", code: blocksToCode(blocks) };
        assert.equal(html(code), html(blocks), `${preset.id}/${kind}`);
      }
    }
  });

  it("隠したブロックは出ない・並べ替えた順に出る", () => {
    const layout = defaultLayout("settlement");
    const before = text(html(layout));
    assert.ok(before.indexOf("総売上") < before.indexOf("純売上"));
    const [total, net] = [layout.blocks.findIndex((b) => b.id === "total"), layout.blocks.findIndex((b) => b.id === "net")];
    [layout.blocks[total], layout.blocks[net]] = [layout.blocks[net], layout.blocks[total]];
    const after = text(html(layout));
    assert.ok(after.indexOf("純売上") < after.indexOf("総売上"));
    layout.blocks.find((b) => b.id === "tax")!.hidden = true;
    assert.ok(!text(html(layout)).includes("消費税"));
  });

  it("文言の欄は HTML をエスケープし、{{ }} の差し込みは値を入れる", () => {
    const layout = defaultLayout("sales");
    layout.blocks = [{ id: "t", type: "text", settings: { ...defaultSettings(BLOCK_DEFS.find((d) => d.type === "text")!), text: "<b>A&B</b>\n注文 {{ order.name }}" } }];
    const h = html(layout);
    assert.match(h, /&lt;b&gt;A&amp;B&lt;\/b&gt;<br\/>注文 #1042/);
  });

  it("注文のデータに含まれる HTML はエスケープされる", () => {
    const data = sampleTemplateData("sales") as Record<string, any>;
    data.order = { ...data.order, line_items: [{ ...data.order.line_items[0], title: `<img src=x onerror="alert(1)">` }] };
    const h = html(defaultLayout("sales"), data);
    assert.ok(!h.includes("<img src=x"));
    assert.ok(h.includes("&lt;img src=x onerror=&#34;alert(1)&#34;&gt;"));
  });

  it("金額は ¥ と 3 桁区切り、件数は区切りと単位", () => {
    const t = text(html(defaultLayout("settlement")));
    assert.match(t, /総売上 ¥128,400/);
    assert.match(t, /件数 42件/);
    assert.match(t, /現金 \(18件\) ¥45,300/);
    assert.match(t, /うち返金 1件 -¥4,950/);
  });

  it("用紙の幅で本文の幅が変わる", () => {
    const l = defaultLayout("receipt");
    assert.match(html(l), /width:576px/);
    assert.match(html({ ...l, paperWidthMm: 58 }), /width:384px/);
  });

  it("include・render は使えず、理由を返す", () => {
    const l: ReceiptLayout = { ...defaultLayout("sales"), mode: "code", code: `{% include "x" %}` };
    const r = renderReceiptLayout(l, sampleTemplateData("sales"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /ほかのファイルを読むタグは使えません/);
  });

  it("書き方の誤りは何行目かを返す", () => {
    const l: ReceiptLayout = { ...defaultLayout("sales"), mode: "code", code: "a\n{% if x %}b" };
    const r = renderReceiptLayout(l, sampleTemplateData("sales"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /2 行目/);
  });

  it("textSettingToLiquid は改行を <br/> にする", () => {
    assert.equal(textSettingToLiquid("a\nb{{ x }}<"), "a<br/>b{{ x }}&lt;");
  });

  it("画像の URL は https か data:image だけ", () => {
    assert.ok(isSafeImageUrl(""));
    assert.ok(isSafeImageUrl("https://cdn.shopify.com/s/files/logo.png"));
    assert.ok(!isSafeImageUrl("http://example.com/a.png"));
    assert.ok(!isSafeImageUrl("javascript:alert(1)"));
    assert.ok(!isSafeImageUrl(`https://x.com/a.png" onerror="x`));
  });
});

describe("receiptLayout: 保存前の確認", () => {
  it("ひな形はすべてそのまま保存できる", () => {
    for (const p of LAYOUT_PRESETS) for (const k of p.kinds) {
      const r = validateLayoutInput(clone(p.build(k)), k);
      assert.ok(r.ok, `${p.id}/${k}: ${r.ok ? "" : r.errors.join(" / ")}`);
    }
  });

  it("知らない設定・使えないブロック・{% %} の入った文言は断り、どこかを書く", () => {
    const l = clone(defaultLayout("receipt")) as any;
    l.blocks[0].settings.unknown = 1;
    l.blocks.push({ id: "x", type: "line_items", settings: {} });
    l.blocks[1].settings.name = "{% if a %}x{% endif %}";
    const r = validateLayoutInput(l, "receipt");
    assert.equal(r.ok, false);
    const msg = r.ok ? "" : r.errors.join("\n");
    assert.match(msg, /1 番目のブロック「見出し」に受け取れない設定「unknown」/);
    assert.match(msg, /は領収書では使えません/);
    assert.match(msg, /「会社名」に \{% %\} のタグは書けません/);
  });

  it("コードの誤りは保存しない", () => {
    const l = { ...clone(defaultLayout("gift")), mode: "code", code: "{% for x in y %}" };
    const r = validateLayoutInput(l, "gift");
    assert.equal(r.ok, false);
  });

  it("文字の大きさの範囲外は断る", () => {
    const l = clone(defaultLayout("gift"));
    l.style.fontSizePx = 99;
    assert.equal(validateLayoutInput(l, "gift").ok, false);
  });

  it("壊れた保存値は標準に戻し、知らないブロックは外して読む", () => {
    assert.deepEqual(normalizeLayout(null, "sales"), defaultLayout("sales"));
    const l = clone(defaultLayout("sales")) as any;
    l.blocks.push({ id: "z", type: "nope", settings: {} });
    l.blocks[0].settings.size = "huge";
    const n = normalizeLayout(l, "sales");
    assert.equal(n.blocks.length, defaultLayout("sales").blocks.length);
    assert.equal(n.blocks[0].settings.size, "l");
  });
});

describe("receiptLayout: Ciara 風のひな形（参考画像 2026-11-22）", () => {
  it("販売レシート: ロゴ・領収書・店舗・明細の見出し・CT の注記・スタッフの順", () => {
    const t = text(html(ciaraSalesLayout()));
    const order = ["Ciara", "領収書", "サンプルストア 渋谷店", "150-0001", "03-1234-5678", "アイテム 商品価格", "シェルインナーシート ¥990", "ShellBlue / iPhone15", "小計 ¥4,950", "CT (10%) 商品価格に含まれています ¥450", "合計 ¥4,950", "現金 ¥5,000", "2026年11月22日 20:58", "スタッフ：山田", "領収書: #1042"];
    let at = -1;
    for (const s of order) {
      const i = t.indexOf(s, at + 1);
      assert.ok(i > at, `「${s}」が順に出ていない: ${t}`);
      at = i;
    }
    // 1 個の商品は数量を出さない、2 個以上は出す
    assert.ok(!t.includes("1 x ¥990"));
    assert.ok(t.includes("2 x ¥2,200"));
  });

  it("領収書: 様・金額のあとのハイフン・税と支払方法・但し書き・担当印", () => {
    const t = text(html(ciaraReceiptLayout()));
    for (const s of ["Ciara", "領収書", "山田 太郎 様", "¥4,950-", "消費税 (10%)：¥450", "現金：¥4,950", "上記金額を正に領収いたしました。", "但 お品代 として", "担当印"]) {
      assert.ok(t.includes(s), `「${s}」がない: ${t}`);
    }
  });

  it("精算（仮）: Ciara のメタフィールドの値を全部出せる", () => {
    const t = text(html(ciaraSettlementLayout()));
    for (const s of ["【精算レシート】", "純売上 ¥116,728", "総売上 ¥128,400", "ポイント利用 ¥500", "返金件数 1件", "点数 57点", "電子マネー(QR) (8件) ¥21,900", "確認印"]) {
      assert.ok(t.includes(s), `「${s}」がない: ${t}`);
    }
    assert.ok(!t.includes("商品券釣有り差額"), "0 のときは出さない");
  });
});
