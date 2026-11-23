/**
 * POS の UI 拡張で、POS に無い部品（s-select・s-option・s-checkbox など）を使っていないかを見る。
 *
 * POS に無い部品は、エラーも出さずに何も描かれない。
 * 例: 特殊返金の「返金種別」「元の支払手段」「実際の返金手段」を s-select で作っていたため、
 * 選ぶ欄が出ないまま初めの値（現金返金・現金）で登録されていた（2843ee7〜）。
 *
 * 使える部品は @shopify/ui-extensions 2025.10.x の
 * build/ts/surfaces/point-of-sale/components/*.d.ts にある tagName の一覧。
 * extensions/pos-smart-grid/package.json の版を上げたら、この一覧も見直すこと。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXT_DIR = join(ROOT, "extensions");

/** @shopify/ui-extensions 2025.10.x の point-of-sale の部品 */
export const POS_COMPONENT_TAGS = new Set([
  "s-badge",
  "s-banner",
  "s-box",
  "s-button",
  "s-choice",
  "s-choice-list",
  "s-clickable",
  "s-date-field",
  "s-date-picker",
  "s-date-spinner",
  "s-divider",
  "s-email-field",
  "s-heading",
  "s-icon",
  "s-image",
  "s-modal",
  "s-number-field",
  "s-page",
  "s-pos-block",
  "s-qr-code",
  "s-scroll-box",
  "s-search-field",
  "s-section",
  "s-stack",
  "s-text",
  "s-text-area",
  "s-text-field",
  "s-tile",
  "s-time-field",
  "s-time-picker",
]);

const SOURCE_EXT = /\.(jsx?|tsx?|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".shopify"]);

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listSourceFiles(p));
    else if (SOURCE_EXT.test(name)) out.push(p);
  }
  return out;
}

/** コメントを外す（説明文に「s-select」と書いても引っかからないように） */
function stripComments(src) {
  // 行番号がずれないよう、ブロックコメントは改行だけ残す
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** ソースの中の s-* 部品名を拾う（JSX のタグと createElement("s-…")） */
export function findComponentTags(src) {
  const code = stripComments(src);
  const tags = [];
  const re = /<\/?(s-[a-z][a-z0-9-]*)\b|createElement\(\s*["'`](s-[a-z][a-z0-9-]*)["'`]/g;
  let m;
  while ((m = re.exec(code))) {
    const tag = m[1] ?? m[2];
    const line = code.slice(0, m.index).split("\n").length;
    tags.push({ tag, line });
  }
  return tags;
}

describe("POS UI 拡張の部品", () => {
  it("拾い方の確かめ: s-select・s-checkbox を拾い、コメントの中は拾わない", () => {
    const src = `// <s-select> はダメ\n<s-stack><s-select label="a"><s-option value="x" /></s-select><s-checkbox /></s-stack>`;
    const names = findComponentTags(src).map((t) => t.tag);
    assert.deepEqual([...new Set(names)], ["s-stack", "s-select", "s-option", "s-checkbox"]);
  });

  it("部品一覧を作った @shopify/ui-extensions の版のまま（上げたら一覧を見直す）", () => {
    const pkg = JSON.parse(readFileSync(join(EXT_DIR, "pos-smart-grid", "package.json"), "utf8"));
    assert.equal(pkg.dependencies["@shopify/ui-extensions"], "2025.10.x");
  });

  it("extensions/ では POS にある部品だけを使う", () => {
    const files = listSourceFiles(EXT_DIR);
    assert.ok(files.length > 0, "extensions/ のソースが見つからない");
    const bad = [];
    for (const f of files) {
      for (const { tag, line } of findComponentTags(readFileSync(f, "utf8"))) {
        if (!POS_COMPONENT_TAGS.has(tag)) bad.push(`${relative(ROOT, f)}:${line} <${tag}>`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      `POS に無い部品を使っています（POS では何も描かれません）。s-select は PosChoiceField（s-choice-list）に、s-checkbox は PosToggleField に置き換えてください:\n${bad.join("\n")}`,
    );
  });
});
