/**
 * POS 拡張の画面で使っている部品（<Foo ...>）が、そのファイルで定義または import されているか。
 * esbuild は定義の無い部品でも通るので、開いたときに ReferenceError になるのをここで止める（2026-11-24）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../extensions/pos-smart-grid/src");

test("POS の画面で使う部品はすべて定義か import がある", () => {
  const missing = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".jsx"))) {
    const code = readFileSync(join(SRC, f), "utf8");
    const used = new Set([...code.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]));
    for (const name of used) {
      const defined =
        new RegExp(`function ${name}\\b`).test(code) ||
        new RegExp(`(const|let) ${name}\\b`).test(code) ||
        new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(code);
      if (!defined) missing.push(`${f}: <${name}>`);
    }
  }
  assert.deepEqual(missing, []);
});
