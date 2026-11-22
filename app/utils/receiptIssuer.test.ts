import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStaffId,
  staffDisplayName,
  formatReceiptIssuer,
  resolveStaffDisplayName,
} from "./receiptIssuer";

test("normalizeStaffId: 数字・GID・文字列をそろえ、おかしな値は null", () => {
  assert.equal(normalizeStaffId(12345), "12345");
  assert.equal(normalizeStaffId("12345"), "12345");
  assert.equal(normalizeStaffId(" 0077 "), "77");
  assert.equal(normalizeStaffId("gid://shopify/StaffMember/987"), "987");
  assert.equal(normalizeStaffId("gid://shopify/User/5"), "5");
  assert.equal(normalizeStaffId(0), null);
  assert.equal(normalizeStaffId("0"), null);
  assert.equal(normalizeStaffId(""), null);
  assert.equal(normalizeStaffId("山田"), null);
  assert.equal(normalizeStaffId("12a"), null);
  assert.equal(normalizeStaffId(1.5), null);
  assert.equal(normalizeStaffId(null), null);
  assert.equal(normalizeStaffId(undefined), null);
  assert.equal(normalizeStaffId("1".repeat(21)), null);
});

test("staffDisplayName: name を優先し、無ければ 姓 名", () => {
  assert.equal(staffDisplayName({ name: " 山田 太郎 " }), "山田 太郎");
  assert.equal(staffDisplayName({ name: "", lastName: "山田", firstName: "太郎" }), "山田 太郎");
  assert.equal(staffDisplayName({ firstName: "太郎" }), "太郎");
  assert.equal(staffDisplayName({ name: "  " }), null);
  assert.equal(staffDisplayName(null), null);
});

test("formatReceiptIssuer: 名前 → スタッフ ID → —", () => {
  assert.equal(formatReceiptIssuer("山田 太郎", "12"), "山田 太郎");
  assert.equal(formatReceiptIssuer(null, "12"), "スタッフ ID 12");
  assert.equal(formatReceiptIssuer("", ""), "—");
  assert.equal(formatReceiptIssuer(undefined, undefined), "—");
});

test("resolveStaffDisplayName: 引けたら名前、スコープ不足・例外は null", async () => {
  const ok = {
    graphql: async (_q: string, opts?: { variables?: Record<string, unknown> }) => {
      assert.equal(opts?.variables?.id, "gid://shopify/StaffMember/42");
      return Response.json({ data: { staffMember: { name: "佐藤 花子" } } });
    },
  };
  assert.equal(await resolveStaffDisplayName(ok, "42"), "佐藤 花子");

  const denied = {
    graphql: async () => Response.json({ errors: [{ message: "Access denied for staffMember field." }], data: { staffMember: null } }),
  };
  assert.equal(await resolveStaffDisplayName(denied, "42"), null);

  const throws = {
    graphql: async () => {
      throw new Error("GraphQL Client: Forbidden");
    },
  };
  assert.equal(await resolveStaffDisplayName(throws, "42"), null);

  let called = false;
  const never = { graphql: async () => { called = true; return Response.json({}); } };
  assert.equal(await resolveStaffDisplayName(never, null), null);
  assert.equal(called, false);
});
