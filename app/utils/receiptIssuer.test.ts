import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStaffId,
  staffDisplayName,
  attributedStaffFromLineItems,
  formatReceiptIssuer,
} from "./receiptIssuer";

test("normalizeStaffId: 数字・GID をそろえ、おかしな値は null", () => {
  assert.equal(normalizeStaffId(12345), "12345");
  assert.equal(normalizeStaffId(" 0077 "), "77");
  assert.equal(normalizeStaffId("gid://shopify/StaffMember/987"), "987");
  assert.equal(normalizeStaffId(0), null);
  assert.equal(normalizeStaffId(""), null);
  assert.equal(normalizeStaffId("山田"), null);
  assert.equal(normalizeStaffId("gid://shopify/Customer/5"), null);
  assert.equal(normalizeStaffId(1.5), null);
  assert.equal(normalizeStaffId(null), null);
  assert.equal(normalizeStaffId("1".repeat(21)), null);
});

test("staffDisplayName: name を優先し、無ければ 名 姓（注文詳細と同じ）", () => {
  assert.equal(staffDisplayName({ name: " 山田 太郎 " }), "山田 太郎");
  assert.equal(staffDisplayName({ name: "", firstName: "太郎", lastName: "山田" }), "太郎 山田");
  assert.equal(staffDisplayName({ name: "  " }), null);
  assert.equal(staffDisplayName(null), null);
});

test("attributedStaffFromLineItems: 明細の帰属スタッフを順に重複なしで", () => {
  const sm = (id: number, name: string) => ({ staffMember: { id: `gid://shopify/StaffMember/${id}`, name } });
  assert.deepEqual(attributedStaffFromLineItems([sm(1, "山田"), { staffMember: null }, sm(2, "佐藤"), sm(1, "山田")]), {
    staffIds: "1,2",
    names: "山田・佐藤",
  });
  assert.deepEqual(attributedStaffFromLineItems([sm(3, "鈴木")]), { staffIds: "3", names: "鈴木" });
  // 名前が空のスタッフは ID だけ
  assert.deepEqual(attributedStaffFromLineItems([{ staffMember: { id: "gid://shopify/StaffMember/9", name: "" } }]), {
    staffIds: "9",
    names: null,
  });
  // 帰属スタッフがいない注文
  assert.deepEqual(attributedStaffFromLineItems([{ staffMember: null }, {}]), { staffIds: null, names: null });
  assert.deepEqual(attributedStaffFromLineItems(undefined), { staffIds: null, names: null });
});

test("formatReceiptIssuer: 名前 → スタッフ ID → —", () => {
  assert.equal(formatReceiptIssuer("山田・佐藤", "1,2"), "山田・佐藤");
  assert.equal(formatReceiptIssuer(null, "12"), "スタッフ ID 12");
  assert.equal(formatReceiptIssuer(null, "1,2"), "スタッフ ID 1・スタッフ ID 2");
  assert.equal(formatReceiptIssuer("", ""), "—");
  assert.equal(formatReceiptIssuer(undefined, undefined), "—");
});
