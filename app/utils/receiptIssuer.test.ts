import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptIssuerFromAttributedStaff, formatReceiptIssuer } from "./receiptIssuer";

test("receiptIssuerFromAttributedStaff: ID は全員、名前は分かった人だけ", () => {
  assert.deepEqual(
    receiptIssuerFromAttributedStaff([
      { staffId: "1", name: "山田" },
      { staffId: "2", name: null },
      { staffId: "3", name: " 佐藤 " },
      { staffId: "1", name: "山田" },
    ]),
    { createdByStaffId: "1,2,3", createdBy: "山田・佐藤" },
  );
  assert.deepEqual(receiptIssuerFromAttributedStaff([{ staffId: "gid://shopify/StaffMember/9", name: null }]), {
    createdByStaffId: "9",
    createdBy: null,
  });
  // 記録が無い注文（通知の前）・帰属スタッフがいない注文
  assert.deepEqual(receiptIssuerFromAttributedStaff([]), { createdByStaffId: null, createdBy: null });
  assert.deepEqual(receiptIssuerFromAttributedStaff(undefined), { createdByStaffId: null, createdBy: null });
});

test("formatReceiptIssuer: いまの登録名 → 発行時の名前 → スタッフ ID → —", () => {
  // いまの登録名を先に使う（あとから登録しても出る）
  assert.equal(formatReceiptIssuer(null, "1,2", { "1": "山田", "2": "佐藤" }), "山田・佐藤");
  assert.equal(formatReceiptIssuer(null, "1,2", { "1": "山田" }), "山田・スタッフ ID 2");
  // 登録名が無く、発行時の名前だけある
  assert.equal(formatReceiptIssuer("山田・佐藤", "1,2", {}), "山田・佐藤");
  // ID だけ
  assert.equal(formatReceiptIssuer(null, "12"), "スタッフ ID 12");
  // 古い行（ID 列が無い）
  assert.equal(formatReceiptIssuer("旧データ", null), "旧データ");
  assert.equal(formatReceiptIssuer(null, null), "—");
  assert.equal(formatReceiptIssuer("", ""), "—");
});
