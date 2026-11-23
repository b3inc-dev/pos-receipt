/**
 * Shopify の mutation で userErrors に無い項目を選んでいないかを見張る。
 *
 * userErrors が素の UserError 型（field と message だけ）の mutation で `code` を選ぶと、
 * GraphQL の検証で HTTP 500（Field 'code' doesn't exist on type 'UserError'）になる。
 * 試験の admin のモックはクエリを検証しないので、ここで文字列として確かめる。
 * 2026-11-23 に refundCreate で起きた（特殊返金の Shopify 返金がすべて失敗）。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REFUND_CREATE_MUTATION } from "./shopifyRefundExecute.server";

/** userErrors が UserError（code なし）の mutation。型が XxxUserError（code あり）のものは入れない。 */
const PLAIN_USER_ERROR_MUTATIONS = [
  "refundCreate",
  "draftOrderCreate",
  "draftOrderComplete",
  "orderUpdate",
  "tagsAdd",
  "customerCreate",
  "fulfillmentCreateV2",
  "appSubscriptionCreate",
];

function userErrorsFieldsOf(src: string, mutation: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`\\b${mutation}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index);
    const ue = rest.match(/userErrors\s*\{([^}]*)\}/);
    if (!ue) continue;
    // 次の mutation の userErrors を拾わないよう、テンプレート文字列の終わりより前だけを見る
    const end = rest.indexOf("`");
    if (end >= 0 && (ue.index ?? 0) > end) continue;
    out.push(ue[1].split(/[\s,]+/).filter(Boolean));
  }
  return out;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "build") continue;
    if (statSync(p).isDirectory()) files.push(...listSourceFiles(p));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.test\./.test(name)) files.push(p);
  }
  return files;
}

describe("Shopify mutation の userErrors の選び方", () => {
  it("refundCreate の userErrors は field と message だけ（code は無い）", () => {
    const sets = userErrorsFieldsOf(REFUND_CREATE_MUTATION, "refundCreate");
    assert.equal(sets.length, 1);
    assert.deepEqual([...sets[0]].sort(), ["field", "message"]);
  });

  it("素の UserError を返す mutation で code を選んでいない（app と extensions のすべて）", () => {
    const roots = ["../", "../../extensions/"].map((r) => new URL(r, import.meta.url).pathname);
    const bad: string[] = [];
    for (const root of roots) {
      for (const file of listSourceFiles(root)) {
        const src = readFileSync(file, "utf8");
        for (const mutation of PLAIN_USER_ERROR_MUTATIONS) {
          for (const fields of userErrorsFieldsOf(src, mutation)) {
            if (fields.includes("code")) bad.push(`${file}: ${mutation}`);
          }
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  it("見張りが効く（code を選んだ文字列は見つかる）", () => {
    const sample = "`mutation X { refundCreate(input: $i) { userErrors { field message code } } }`";
    assert.ok(userErrorsFieldsOf(sample, "refundCreate")[0].includes("code"));
  });
});
