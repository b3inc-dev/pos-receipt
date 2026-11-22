// 一般設定のデバッグ・診断の欄は開発ストアだけに出す（T さんの決定 2026-11-22）。ソースで確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("app/routes/app.general-settings.tsx", "utf8");

test("一般設定のデバッグ・診断の欄は isDevStore のときだけ出す", () => {
  const start = page.indexOf("{isDevStore && (");
  assert.ok(start > 0, "isDevStore の分かれ目がない");
  const block = page.slice(start);
  for (const label of ["デバッグモード", "診断パネルを有効にする", "詳細計算ログ"]) {
    const at = page.indexOf(`label="${label}"`);
    assert.ok(at > start, `${label} が isDevStore の外にある`);
    assert.ok(block.includes(`label="${label}"`));
  }
});

test("開発ストアかどうかは partnerDevelopment で読み、店の名前を書かない", () => {
  const util = readFileSync("app/utils/devStore.server.ts", "utf8");
  assert.match(util, /partnerDevelopment === true/);
  const code = util.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
  assert.doesNotMatch(code, /\.myshopify\.com|bbbincbbb|ciara/i);
  assert.match(page, /isDevelopmentStore\(admin\)/);
  assert.match(page, /keepDevOnlySettings\(/);
});
