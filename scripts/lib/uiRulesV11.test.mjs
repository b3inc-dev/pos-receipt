// 管理画面の UI ルール v1.1（docs/UI_RULES.md）のうち、ソースで確かめられるものを試験で止める。
// POS Receipt の画面は Polaris React の Page。Page の backAction が画面の中の左上に「←」を出す（3章の BackAction の代わり）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const ui = readFileSync("app/components/admin-ui.tsx", "utf8");
const routes = readdirSync("app/routes")
  .filter((name) => /^app\..*\.tsx$/.test(name))
  .map((name) => ({ name, source: readFileSync(`app/routes/${name}`, "utf8") }));

// 料金（#41）・お金の直し（#11・#13・#16）の PR が直している画面。その PR が main に入ったら直して、ここから外す（docs/UI_RULES.md の表）
const OPEN_PR_SCREENS = new Set([
  "app._index.tsx", "app.budget-management.tsx", "app.budget-template-csv.tsx", "app.channel-budget-management.tsx",
  "app.channel-budget-template-csv.tsx", "app.diagnostics.tsx", "app.plan.callback.tsx", "app.plan.tsx",
  "app.sales-summary.tsx", "app.print-settings.tsx",
  "app.receipt-print-layout.tsx", "app.settlement-print-layout.tsx", "app.settlement-settings.tsx",
  // 印字の一本化（#22・#53）が直している画面
  "app.location-profiles.tsx", "app.settlement-history.tsx",
]);
const checked = routes.filter(({ name }) => !OPEN_PR_SCREENS.has(name));

// 上部メニューから直接開く画面（下の階層でない）。ここにない画面は「←」が要る
const TOP_PAGES = new Set(["app._index.tsx", "app.sales-summary.tsx"]);

test("下の階層の画面は、画面の中に「←」（Page の backAction）がある（3章）", () => {
  for (const { name, source } of routes) {
    if (TOP_PAGES.has(name) || !/<Page\b/.test(source)) continue;
    assert.match(source, /backAction=/, `${name} に「←」がない`);
  }
});

test("adminCss に引用符と > を書かない（サーバーで描くと &quot; &gt; になりセレクタが効かない。13章）", () => {
  const start = ui.indexOf("export const adminCss = `") + "export const adminCss = `".length;
  const css = ui.slice(start, ui.indexOf("`;", start));
  assert.ok(css.length > 1000, "adminCss が見つからない");
  assert.equal(css.includes('"'), false);
  assert.equal(css.includes("'"), false);
  assert.equal(css.includes(">"), false);
});

test("上部メニューは共通の部品で描き、共通の CSS を一緒に1回だけ描く（3章・13章）", () => {
  const nav = readFileSync("app/components/AppNavBar.tsx", "utf8");
  assert.match(nav, /<AdminStyle \/>/);
  assert.match(nav, /<AppNavBarView /);
  assert.match(nav, /match: GROUP_PATHS\[item\.path\]/, "グループの中の画面でも親を選択中にする");
});

test("画面に下線のリンク・要件の章番号（§）・デバッグ API の案内を出さない（4章・10章）", () => {
  for (const { name, source } of checked) {
    assert.equal(/textDecoration:\s*"underline"/.test(source), false, `${name} に下線がある`);
    assert.equal(/description="§/.test(source), false, `${name} の説明に要件の章番号がある`);
    assert.equal(/helpText="[^"]*\/api\/debug/.test(source), false, `${name} にデバッグ API の案内がある`);
  }
});

test("保存の成功は消えるお知らせ枠でなくトーストで出す（7章）", () => {
  const screens = [
    "app.budget-settings.tsx", "app.general-settings.tsx", "app.loyalty-settings.tsx", "app.special-refund-settings.tsx",
    "app.voucher-settings.tsx", "app.sales-receipt-settings.tsx", "app.sales-receipt-layout.tsx", "app.receipt-template.tsx",
  ];
  for (const file of screens) {
    const source = readFileSync(`app/routes/${file}`, "utf8");
    assert.match(source, /<SuccessToast message=\{actionData\?\.ok \? "保存しました" : null\} trigger=\{actionData\} \/>/, file);
    assert.equal(/<Banner tone="success">保存しました/.test(source), false, `${file} に保存の成功の枠が残っている`);
    assert.equal(/<Banner tone="info">/.test(source.slice(0, source.indexOf("<Layout.AnnotatedSection"))), false, `${file} の画面の説明がお知らせ枠のまま`);
  }
});

test("自前の日付欄は共通の CSS（Admin-input）を付ける（6章・13章）", () => {
  for (const { name, source } of checked) {
    for (const match of source.matchAll(/<input\s[^>]*?type="date"[^>]*>/g)) {
      assert.match(match[0], /className="[^"]*Admin-input/, `${name} の日付欄に Admin-input がない`);
    }
  }
});

// 保存の帯（SaveBar）に移した設定の画面。画面の上の「保存」ボタン（Polaris の primaryAction）は置かない（7章）
const SAVE_BAR_SCREENS = [
  "app.budget-settings.tsx", "app.general-settings.tsx", "app.loyalty-settings.tsx", "app.special-refund-settings.tsx",
  "app.voucher-settings.tsx", "app.sales-receipt-settings.tsx", "app.receipt-template.tsx",
];

test("設定の画面は Shopify の保存の帯で保存し、画面の上に保存ボタンを置かない（7章）", () => {
  for (const file of SAVE_BAR_SCREENS) {
    const source = readFileSync(`app/routes/${file}`, "utf8");
    assert.match(source, /<StateSaveForm values=\{[^}]+\}+ onSave=\{handleSave\} onDiscard=\{/, `${file} に保存の帯がない`);
    assert.equal((source.match(/<StateSaveForm\b/g) ?? []).length, 1, `${file} の保存の帯は 1 つ`);
    assert.equal(/primaryAction=\{\{ content: "保存"/.test(source), false, `${file} に画面の上の保存ボタンが残っている`);
    assert.match(source, /const navigate = useGuardedNavigate\(\);/, `${file} の「←」が未保存を確かめずに移る`);
  }
});

test("保存の帯の囲みは、送る中身を作らず各画面の onSave に任せ、帯を 1 つだけ置く（7章）", () => {
  const source = readFileSync("app/components/StateSaveForm.tsx", "utf8");
  assert.equal((source.match(/<SaveBar\b/g) ?? []).length, 1);
  assert.match(source, /event\.preventDefault\(\);/, "フォームをそのまま送らない");
  assert.match(source, /onSave\(\)/);
  assert.match(source, /failed=\{failed\}/, "失敗のあとは帯を出し直す");
  assert.match(source, /onDiscard\(saved\.current\)/, "破棄は最後に保存した値に戻す");
  assert.match(source, /closest\("ui-save-bar"\)/, "帯のボタンからの送信（二重の送信・破棄での送信）を止める");
});

// 表をスマホで 1 件 1 枚のカードにした画面（8章）
const HISTORY_TABLE_SCREENS = ["app.receipt-history.tsx", "app.special-refund-history.tsx", "app.payment-methods.tsx"];

test("表は History-table にし、各セルに data-label を付ける（Polaris の IndexTable はスマホで横スクロールになる。8章）", () => {
  for (const file of HISTORY_TABLE_SCREENS) {
    const source = readFileSync(`app/routes/${file}`, "utf8");
    assert.equal(/IndexTable/.test(source), false, `${file} に IndexTable が残っている`);
    assert.match(source, /<table className="History-table">/, file);
    const cells = source.match(/<td\b[^>]*>/g) ?? [];
    assert.ok(cells.length > 0, file);
    for (const cell of cells) assert.match(cell, /data-label="/, `${file} の ${cell} に data-label がない`);
  }
});

test("履歴の期間の欄は Polaris の日付欄でなく共通の日付欄（6章・13章）", () => {
  for (const { name, source } of checked) {
    assert.equal(/<TextField[^>]*type="date"/s.test(source.replace(/<TextField/g, "\n<TextField")), false, `${name} に Polaris の日付欄がある`);
  }
  const date = readFileSync("app/components/DateFilter.tsx", "utf8");
  assert.match(date, /className="Admin-input"/);
  assert.match(date, /type="date"/);
});

test("削除はブラウザの confirm() でなく確認の窓で出す（4章）", () => {
  for (const { name, source } of checked) {
    assert.equal(/\bconfirm\(/.test(source), false, `${name} がブラウザの confirm() を使っている`);
  }
});
