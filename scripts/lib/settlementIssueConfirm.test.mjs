/**
 * 精算画面の「点検」「精算」を押したときに、確かに画面が変わることの見張り。
 *
 * iPhone の POS で「点検」を押しても発行確認（s-modal の重ね表示）が出ず、見出しが変わるだけに見えた（2026-11-23）。
 * 発行確認は confirm の画面に切り替える形にしたので、ボタンの command / commandFor と s-modal に戻さない。
 * あわせて、精算画面の時刻は日本時間で出す。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { formatJstHm } from "../../extensions/common/dateDisplay.js";

const SRC = readFileSync(
  fileURLToPath(new URL("../../extensions/pos-smart-grid/src/SettlementModal.jsx", import.meta.url)),
  "utf8",
);

describe("精算画面の発行確認", () => {
  it("点検・精算の発行確認は重ね表示（s-modal）を使わない", () => {
    assert.equal(/<s-modal\b/.test(SRC), false);
    assert.equal(/(middle|right)Command(For)?=/.test(SRC), false);
  });

  it("点検・精算のボタンは confirm の画面に切り替える", () => {
    assert.match(SRC, /step === "confirm"/);
    const n = SRC.match(/setStep\("confirm"\)/g)?.length ?? 0;
    assert.ok(n >= 2, `setStep("confirm") が点検・精算の 2 か所に無い（${n} か所）`);
  });

  it("エラーは一覧の上（SettlementTopNotices）に出し、下に赤字を置かない", () => {
    assert.match(SRC, /<SettlementTopNotices /);
    assert.equal(/\{error \? <s-text tone="critical">\{error\}<\/s-text> : null\}\s*<\/s-stack>\s*<\/s-box>\s*<\/s-scroll-box>/.test(SRC), false);
  });
});

describe("formatJstHm", () => {
  it("UTC を日本時間の HH:MM にする", () => {
    assert.equal(formatJstHm(Date.UTC(2026, 10, 23, 12, 9)), "21:09");
    assert.equal(formatJstHm(new Date(Date.UTC(2026, 10, 23, 15, 30))), "00:30");
  });
  it("時刻でないときは空にする", () => {
    assert.equal(formatJstHm(NaN), "");
    assert.equal(formatJstHm(undefined), "");
  });
});
