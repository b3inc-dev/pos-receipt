/**
 * POS の読み込み中の表示を全画面で揃える決まりの見張り（T 2026-11-24）。
 *
 * - 読み込み中は青い帯「読み込み中です。少しお待ちください。」ひとつ（LoadingNotice）。
 * - 「再読み込み」は失敗したとき、または 10 秒待ったときだけ。
 * - 欄の中など一部の読み込みの文字は「読み込み中…」だけ（「精算の数を」「月一覧を」などの前置きを付けない）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  INLINE_LOADING_TEXT,
  LOADING_MESSAGE,
  SLOW_LOADING_MS,
  loadingNoticeView,
} from "../../extensions/common/loadingNotice.js";

const SRC_DIR = fileURLToPath(new URL("../../extensions/pos-smart-grid/src/", import.meta.url));
const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".jsx") || f.endsWith(".js"));
const sources = Object.fromEntries(files.map((f) => [f, readFileSync(SRC_DIR + f, "utf8")]));

describe("loadingNoticeView", () => {
  it("読み込み中は青い帯で、決まった文。再読み込みはまだ出さない", () => {
    assert.deepEqual(loadingNoticeView({ loading: true, canRetry: true }), {
      tone: "info",
      heading: "読み込み中です。少しお待ちください。",
      showRetry: false,
    });
    assert.equal(LOADING_MESSAGE, "読み込み中です。少しお待ちください。");
  });

  it("10 秒待たされたら再読み込みを出す（再読み込みできる画面だけ）", () => {
    assert.equal(SLOW_LOADING_MS, 10_000);
    assert.equal(loadingNoticeView({ loading: true, slow: true, canRetry: true }).showRetry, true);
    assert.equal(loadingNoticeView({ loading: true, slow: true, canRetry: false }).showRetry, false);
  });

  it("失敗したら赤い帯と再読み込み。読み込み中なら失敗の文より読み込み中を出す", () => {
    assert.deepEqual(loadingNoticeView({ error: "読み込めませんでした。", canRetry: true }), {
      tone: "critical",
      heading: "読み込めませんでした。",
      showRetry: true,
    });
    assert.equal(loadingNoticeView({ loading: true, error: "x", canRetry: true }).tone, "info");
  });

  it("読み込みが終わって失敗も無ければ何も出さない", () => {
    assert.equal(loadingNoticeView({ loading: false, error: "  " }).tone, null);
  });

  it("一部の読み込みの文字は「読み込み中…」だけ", () => {
    assert.equal(INLINE_LOADING_TEXT, "読み込み中…");
  });
});

describe("POS の画面の読み込み表示", () => {
  it("読み込み中の文字に前置きを付けない・別の言い方をしない", () => {
    const banned = [
      /を読み込み中/,
      /を読み込んでいます…/,
      /を取得中…/,
      /を確認中…/,
      /確認しています…/,
      /取引を開いています…/,
      /読込中\.\./,
    ];
    for (const [f, src] of Object.entries(sources)) {
      // コメントは除く（経緯の説明に昔の文が出てくるため）
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const re of banned) {
        assert.equal(re.test(code), false, `${f} に ${re} が残っている`);
      }
    }
  });

  it("精算の数が無いあいだに「精算の数を読み込み中…」と大きな「再読み込み」に切り替えない", () => {
    const src = sources["SettlementModal.jsx"];
    assert.equal(/精算の数を読み込み中/.test(src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")), false);
    assert.equal(/function SettlementTopNotices/.test(src), false);
  });

  it("読み込み中の帯は共通部品（LoadingNotice / LoadingPage）だけが出す", () => {
    for (const [f, src] of Object.entries(sources)) {
      if (f === "LoadingNotice.jsx") continue;
      assert.equal(
        /<s-banner[^>]*読み込み中/.test(src),
        false,
        `${f} が読み込み中の帯を自前で出している`,
      );
    }
    const users = Object.entries(sources).filter(([, s]) => /<Loading(Notice|Page)\b/.test(s)).map(([f]) => f);
    for (const f of [
      "SettlementModal.jsx",
      "SalesSummaryModal.jsx",
      "OrderDayListScreen.jsx",
      "ReceiptModal.jsx",
      "SalesReceiptModal.jsx",
      "SpecialRefundModal.jsx",
      "VoucherModal.jsx",
      "RefundReservationForm.jsx",
    ]) {
      assert.ok(users.includes(f), `${f} が共通の読み込み表示を使っていない`);
      assert.match(sources[f], /import \{[^}]*Loading(Notice|Page)[^}]*\} from "\.\/LoadingNotice\.jsx"/);
    }
  });
});
