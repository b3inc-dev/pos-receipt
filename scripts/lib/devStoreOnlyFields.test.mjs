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

test("「プラン（表示用）」「有効機能 JSON（表示用）」も isDevStore のときだけ出す", () => {
  for (const label of ["プラン（表示用）", "有効機能 JSON（表示用）"]) {
    const at = page.indexOf(`label="${label}"`);
    const guard = page.lastIndexOf("{isDevStore && (", at);
    assert.ok(at > 0 && guard > 0, `${label} の前に isDevStore の分かれ目がない`);
    // 分かれ目のあとの「</>」で閉じる前に欄がある（同じ分かれ目の中にある）
    const close = page.indexOf("</>", guard);
    assert.ok(close > at, `${label} が isDevStore の外にある`);
  }
});

/** 「システム診断」の枠（見出し〜閉じ）が {isDevStore && ( … )} または {isDevStore ? ( … ) : null} の中にあるか */
function diagnosticsBoxIsGuarded(src) {
  const title = src.indexOf('title="システム診断"');
  assert.ok(title > 0, "システム診断の枠が見つからない");
  // 店舗の画面（AdminBlock）と、ホーム（Polaris の Layout.AnnotatedSection）の 2 つの書き方
  const close = src.lastIndexOf("<AdminBlock", title) > src.lastIndexOf("<Layout.AnnotatedSection", title) ? "</AdminBlock>" : "</Layout.AnnotatedSection>";
  const guard = Math.max(src.lastIndexOf("{isDevStore && (", title), src.lastIndexOf("{isDevStore ? (", title));
  assert.ok(guard > 0, "システム診断の前に isDevStore の分かれ目がない");
  assert.ok(!src.slice(guard, title).includes(close), "分かれ目が枠の前で閉じている");
  const end = src.indexOf(close, title);
  const after = src.slice(end, end + 80);
  assert.ok(after.includes(")}") || after.includes(") : null}"), "枠のすぐあとで分かれ目を閉じていない");
}

test("店舗設定とホームの「システム診断」の枠は開発ストアだけ", () => {
  for (const f of ["app/routes/app.settings.tsx", "app/routes/app._index.tsx"]) {
    const src = readFileSync(f, "utf8");
    diagnosticsBoxIsGuarded(src);
    assert.match(src, /const isDevStore = await isDevelopmentStore\(admin\);/, f);
  }
});

test("/app/diagnostics は開発ストアでなければ 404（DB を読む前に止める）", () => {
  const src = readFileSync("app/routes/app.diagnostics.tsx", "utf8");
  const gate = src.indexOf("await requireDevelopmentStore(admin);");
  assert.ok(gate > 0, "requireDevelopmentStore が無い");
  assert.ok(gate < src.indexOf("resolveShop(session.shop"), "店の読み込みより前に止める");
  assert.ok(gate < src.indexOf("prisma."), "DB を読むより前に止める");
  assert.doesNotMatch(src, /export async function action/, "action が増えたら同じ門番を付ける");
});

test("高度な設定の「システム診断」ボタンは showDiagnostics のときだけ（既定は出さない）", () => {
  const nav = readFileSync("app/components/SystemAdvancedNav.tsx", "utf8");
  assert.match(nav, /showDiagnostics = false/);
  assert.match(nav, /path: "\/app\/diagnostics", label: "システム診断", devStoreOnly: true/);
  const pageNav = readFileSync("app/components/SystemPageNav.tsx", "utf8");
  assert.match(pageNav, /isDevStore = false/);
  assert.match(pageNav, /<SystemAdvancedNav showDiagnostics=\{isDevStore\} \/>/);
});

test("開発ストアかどうかは partnerDevelopment で読み、店の名前を書かない", () => {
  const util = readFileSync("app/utils/devStore.server.ts", "utf8");
  assert.match(util, /partnerDevelopment === true/);
  const code = util.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
  assert.doesNotMatch(code, /\.myshopify\.com|bbbincbbb|ciara/i);
  assert.match(page, /isDevelopmentStore\(admin\)/);
  assert.match(page, /keepDevOnlySettings\(/);
});
