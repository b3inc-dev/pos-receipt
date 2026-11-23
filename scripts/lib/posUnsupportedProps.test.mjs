/**
 * POS の UI 拡張で、POS に無い属性を使っていないかを見る（T 2026-11-24 の UI ルール）。
 *
 * POS に無い属性はエラーも出さずに無視される。例: 売上サマリーの年・月のボタンを kind="primary" で
 * 選んだ印にしていたため、選んだ年・月が色で分からなかった。s-text の fontWeight・size・fontSize・
 * emphasis、tone="subdued" も効かない（太字は type="strong"、小さい字は type="small"、灰色は color="subdued"）。
 *
 * 型は @shopify/ui-extensions 2025.10.x の point-of-sale の Button.d.ts・Text.d.ts・Stack.d.ts。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../extensions/pos-smart-grid/src", import.meta.url));

/** 別の持ち主の PR で直している画面（精算）。そちらが入ったら外す */
const PENDING_FILES = new Set(["SettlementModal.jsx"]);

const RULES = [
  { name: "s-button の kind（POS は variant）", re: /<s-button\b[^>]*\skind=/ },
  { name: "s-text の fontWeight / fontSize / size / emphasis", re: /<s-text\b[^>]*\s(fontWeight|fontSize|size|emphasis)=/ },
  { name: 's-text の tone="subdued"（POS は color="subdued"）', re: /<s-text\b[^>]*\stone="subdued"/ },
  { name: 's-stack の direction="horizontal" / align', re: /<s-stack\b[^>]*\s(direction="horizontal"|align=)/ },
  { name: 'gap="extraSmall"（POS は small-300 など）', re: /\sgap="extraSmall"/ },
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** 開きタグ（複数行も）ごとに 1 行へ寄せて調べる */
export function findUnsupportedProps(src) {
  const code = stripComments(src);
  const out = [];
  const tagRe = /<s-[a-z-]+\b[^<>]*>/g;
  let m;
  while ((m = tagRe.exec(code))) {
    const tag = m[0].replace(/\s+/g, " ");
    for (const r of RULES) {
      if (r.re.test(tag)) out.push({ rule: r.name, line: code.slice(0, m.index).split("\n").length });
    }
  }
  return out;
}

describe("POS に無い属性", () => {
  it("拾い方の確かめ", () => {
    const src = `<s-button kind="primary">a</s-button>\n<s-text\n  size="small">b</s-text>\n// <s-text fontWeight="bold">\n<s-text type="small" color="subdued">c</s-text>`;
    assert.deepEqual(findUnsupportedProps(src).map((x) => x.line), [1, 2]);
  });

  it("POS の画面では POS にある属性だけを使う", () => {
    const bad = [];
    for (const name of readdirSync(SRC)) {
      if (!/\.jsx?$/.test(name) || PENDING_FILES.has(name)) continue;
      for (const f of findUnsupportedProps(readFileSync(join(SRC, name), "utf8"))) {
        bad.push(`${name}:${f.line} ${f.rule}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});
