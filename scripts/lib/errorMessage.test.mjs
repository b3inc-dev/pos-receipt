/**
 * POS のエラー文は店の人が読む。技術の言葉を出さず、取れる行動（通信を確かめる・もう一度・管理者に連絡）で書く。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toUserMessage } from "../../extensions/common/errorMessage.js";

const TECH_WORDS = /接続先|認証|URL|API|Load failed|fetch/i;

describe("toUserMessage", () => {
  const inputs = ["Load failed", "Failed to fetch", "Network request failed", "HTTP 401", "HTTP 403", "HTTP 404", "HTTP 500", "HTTP 503", "throttled", "", undefined];
  for (const input of inputs) {
    it(`${JSON.stringify(input)} は技術の言葉を出さない`, () => {
      const out = toUserMessage(input);
      assert.ok(out.length > 0);
      assert.equal(TECH_WORDS.test(out), false, out);
    });
  }

  it("読み込みの失敗は、もう一度読み込むことと管理者への連絡を書く", () => {
    const out = toUserMessage("Load failed");
    assert.match(out, /もう一度読み込んで/);
    assert.match(out, /管理者に連絡/);
  });

  it("サーバーの中の英語のエラー（データベースの文など）は出さず、いつもの案内にする", () => {
    const raw =
      "Invalid `prisma.specialRefundEvent.findMany()` invocation: The column `SpecialRefundEvent.foo` does not exist in the current database.";
    const out = toUserMessage(raw);
    assert.notEqual(out, raw);
    assert.equal(/prisma|invocation|column/i.test(out), false, out);
    assert.match(out, /管理者に連絡/);
    assert.equal(toUserMessage("Internal Server Error"), toUserMessage(undefined));
  });

  it("日本語のサーバーの文はそのまま返す", () => {
    assert.equal(toUserMessage("この日はもう精算済みです"), "この日はもう精算済みです");
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withStatus } from "../../extensions/common/errorMessage.js";
import { specialRefundEventTypeLabel } from "../../extensions/common/specialRefundLabels.js";

describe("画面に出すエラー文と表記", () => {
  it("API クライアントはエラー文に (HTTP 500) のような番号を付けない", () => {
    const dir = fileURLToPath(new URL("../../extensions/common/", import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const src = readFileSync(dir + f, "utf8");
      assert.equal(/` \(HTTP \$\{/.test(src), false, f);
    }
  });

  it("withStatus は番号を err.status に残し、文は変えない", () => {
    const e = withStatus(new Error("うまくいきませんでした"), 500);
    assert.equal(e.message, "うまくいきませんでした");
    assert.equal(e.status, 500);
  });

  it("特殊返金の種類は日本語の名前にする", () => {
    assert.equal(specialRefundEventTypeLabel("cash_refund"), "現金返金");
    assert.equal(specialRefundEventTypeLabel("payment_method_override"), "返金方法変更");
    assert.equal(specialRefundEventTypeLabel("something_new"), "調整");
    assert.equal(specialRefundEventTypeLabel("voucher_change_adjustment"), "商品券釣銭登録");
    assert.equal(specialRefundEventTypeLabel(undefined), "調整");
  });
});
