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

  it("日本語のサーバーの文はそのまま返す", () => {
    assert.equal(toUserMessage("この日はもう精算済みです"), "この日はもう精算済みです");
  });
});
