import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStaffId, parseStaffNameMap, issuerNameAtIssue, formatReceiptIssuer } from "./receiptIssuer";

test("normalizeStaffId: POS の staffMemberId・userId・GID をそろえ、おかしな値は null", () => {
  assert.equal(normalizeStaffId(12345), "12345");
  assert.equal(normalizeStaffId(" 0077 "), "77");
  assert.equal(normalizeStaffId("gid://shopify/StaffMember/987"), "987");
  assert.equal(normalizeStaffId(0), null);
  assert.equal(normalizeStaffId(-3), null);
  assert.equal(normalizeStaffId(1.5), null);
  assert.equal(normalizeStaffId(""), null);
  assert.equal(normalizeStaffId("山田"), null);
  assert.equal(normalizeStaffId("1,2"), null);
  assert.equal(normalizeStaffId({ id: 1 }), null);
  assert.equal(normalizeStaffId(null), null);
  assert.equal(normalizeStaffId("1".repeat(21)), null);
});

test("parseStaffNameMap: 「スタッフ名」の保存値から ID → 名前", () => {
  assert.deepEqual(parseStaffNameMap({ names: { "12": " 山田  太郎 ", "x": "だめ", "13": "", "14": 5 } }), { "12": "山田 太郎" });
  assert.deepEqual(parseStaffNameMap(null), {});
  assert.deepEqual(parseStaffNameMap({ names: ["a"] }), {});
});

test("issuerNameAtIssue: 登録があれば名前", () => {
  assert.equal(issuerNameAtIssue("12", { "12": "山田" }), "山田");
  assert.equal(issuerNameAtIssue("13", { "12": "山田" }), null);
  assert.equal(issuerNameAtIssue(null, { "12": "山田" }), null);
});

test("formatReceiptIssuer: いまの登録名 → 発行時の名前 → スタッフ ID → —", () => {
  assert.equal(formatReceiptIssuer("旧名", "12", { "12": "山田" }), "山田");
  assert.equal(formatReceiptIssuer("山田", "12", {}), "山田");
  assert.equal(formatReceiptIssuer(null, "12"), "スタッフ ID 12");
  assert.equal(formatReceiptIssuer(null, null), "—");
  assert.equal(formatReceiptIssuer("", ""), "—");
});
