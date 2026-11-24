import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isYmd, parseHistoryLimit } from "./receiptHistoryParams";

describe("領収書の発行履歴 API の入力", () => {
  it("件数は 1〜50", () => {
    assert.equal(parseHistoryLimit(null), 20);
    assert.equal(parseHistoryLimit("0"), 20);
    assert.equal(parseHistoryLimit("-5"), 20);
    assert.equal(parseHistoryLimit("abc"), 20);
    assert.equal(parseHistoryLimit("1"), 1);
    assert.equal(parseHistoryLimit("50"), 50);
    assert.equal(parseHistoryLimit("500"), 50);
  });
  it("日付は YYYY-MM-DD の実在する日だけ", () => {
    assert.equal(isYmd("2026-11-24"), true);
    assert.equal(isYmd("2026-02-30"), false);
    assert.equal(isYmd("2026/11/24"), false);
    assert.equal(isYmd("bad"), false);
  });
  it("店の指定なし（注文の指定もなし）は 400、日付が変なら 400、続きは cursor で読む", () => {
    const src = readFileSync(new URL("../routes/api.receipts.history.tsx", import.meta.url), "utf8");
    assert.match(src, /if \(!orderId && !locRaw\)[\s\S]{0,120}status: 400/);
    assert.match(src, /!isYmd\(dateFrom\)[\s\S]{0,160}status: 400/);
    assert.match(src, /take: limit \+ 1/);
    assert.match(src, /cursor: \{ id: cursor \}, skip: 1/);
    assert.match(src, /orderBy: \[\{ createdAt: "desc" \}, \{ id: "desc" \}\]/);
    assert.match(src, /nextCursor,/);
  });
  it("POS の発行履歴は続きを読める", () => {
    const src = readFileSync(new URL("../../extensions/pos-smart-grid/src/ReceiptModal.jsx", import.meta.url), "utf8");
    assert.match(src, /cursor: params\.cursor/);
    assert.match(src, /nextCursor: res\.nextCursor \?\? null/);
    const api = readFileSync(new URL("../../extensions/common/receiptApi.js", import.meta.url), "utf8");
    assert.match(api, /params\.set\("cursor"/);
  });
  it("名前なしで読み直したときは記録を残す", () => {
    const src = readFileSync(new URL("./protectedCustomerData.ts", import.meta.url), "utf8");
    assert.match(src, /console\.info\(`\[protected-customer-data\]/);
  });
});
