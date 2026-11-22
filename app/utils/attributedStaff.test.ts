import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStaffDisplayNames,
  formatAttributedStaffList,
  normalizeStaffId,
  parseOrderAttributionPayload,
  parseStaffDisplayNames,
  scopeIncludesReadUsers,
  staffMemberDisplayName,
  summarizeAttributedStaff,
} from "./attributedStaff";

// Webhook（REST の形）の本文。attributed_staffs は changelog の例と同じ GID 文字列＋数量
// https://shopify.dev/changelog/sale-attribution-edits-now-can-be-subscribed-via-orders-updated-webhook
function payload(lineItems: unknown[], extra: Record<string, unknown> = {}) {
  return { id: 5001, admin_graphql_api_id: "gid://shopify/Order/5001", updated_at: "2026-11-23T10:00:00+09:00", line_items: lineItems, ...extra };
}

describe("normalizeStaffId", () => {
  it("数・数字の文字列・StaffMember / User の GID を数字にそろえる", () => {
    assert.equal(normalizeStaffId(123), "123");
    assert.equal(normalizeStaffId(" 0123 "), "123");
    assert.equal(normalizeStaffId("gid://shopify/StaffMember/77"), "77");
    assert.equal(normalizeStaffId("gid://shopify/User/78"), "78");
  });
  it("おかしな値は null", () => {
    for (const v of [null, undefined, "", "0", 0, -1, 1.5, "abc", "gid://shopify/Customer/1", {}, "1".repeat(21)]) {
      assert.equal(normalizeStaffId(v), null, String(v));
    }
  });
});

describe("parseOrderAttributionPayload", () => {
  it("明細ごとの帰属（ID・数量）と並びを取り出す", () => {
    const r = parseOrderAttributionPayload(
      payload([
        { id: 11, quantity: 2, attributed_staffs: [{ id: "gid://shopify/StaffMember/900", quantity: 2 }] },
        { id: 12, quantity: 3, attributed_staffs: [{ id: "gid://shopify/StaffMember/901", quantity: 1 }, { id: "gid://shopify/StaffMember/900", quantity: 2 }] },
        { id: 13, quantity: 1, attributed_staffs: [] },
      ]),
    );
    assert.ok(r);
    assert.equal(r.orderId, "5001");
    assert.equal(r.sourceUpdatedAt?.toISOString(), "2026-11-23T01:00:00.000Z");
    assert.deepEqual(r.lines, [
      { lineItemId: "11", position: 0, staffId: "900", quantity: 2 },
      { lineItemId: "12", position: 1, staffId: "901", quantity: 1 },
      { lineItemId: "12", position: 1, staffId: "900", quantity: 2 },
    ]);
  });
  it("数量が無いときは、1 人だけならその明細の数量、2 人以上なら 1", () => {
    const r = parseOrderAttributionPayload(
      payload([
        { id: 21, quantity: 4, attributed_staffs: [{ id: 900 }] },
        { id: 22, quantity: 4, attributed_staffs: [{ id: 900 }, { id: 901, quantity: "x" }] },
      ]),
    );
    assert.deepEqual(r?.lines.map((l) => [l.lineItemId, l.staffId, l.quantity]), [
      ["21", "900", 4],
      ["22", "900", 1],
      ["22", "901", 1],
    ]);
  });
  it("同じ明細に同じスタッフが 2 回出たら数量を足す。読めない ID は捨てる", () => {
    const r = parseOrderAttributionPayload(
      payload([{ id: 31, quantity: 3, attributed_staffs: [{ id: 900, quantity: 1 }, { id: "gid://shopify/StaffMember/900", quantity: 2 }, { id: "bad" }, null] }]),
    );
    assert.deepEqual(r?.lines, [{ lineItemId: "31", position: 0, staffId: "900", quantity: 3 }]);
  });
  it("帰属が無い注文（オンラインストアなど）は lines が空。注文 ID が無ければ null", () => {
    assert.deepEqual(parseOrderAttributionPayload(payload([{ id: 41, quantity: 1 }]))?.lines, []);
    assert.deepEqual(parseOrderAttributionPayload({ id: 1, line_items: null })?.lines, []);
    assert.equal(parseOrderAttributionPayload({ line_items: [] }), null);
    assert.equal(parseOrderAttributionPayload(null), null);
    assert.equal(parseOrderAttributionPayload("x"), null);
  });
  it("id が無くても admin_graphql_api_id から注文 ID・明細 ID を読む。updated_at が読めなければ null", () => {
    const r = parseOrderAttributionPayload({
      admin_graphql_api_id: "gid://shopify/Order/77",
      updated_at: "not a date",
      line_items: [{ admin_graphql_api_id: "gid://shopify/LineItem/88", attributed_staffs: [{ id: 5, quantity: 1 }] }],
    });
    assert.equal(r?.orderId, "77");
    assert.equal(r?.sourceUpdatedAt, null);
    assert.deepEqual(r?.lines, [{ lineItemId: "88", position: 0, staffId: "5", quantity: 1 }]);
  });
});

describe("summarizeAttributedStaff", () => {
  it("明細の順に重複なし・数量は合計・名前は登録から（無ければ null）", () => {
    const lines = [
      { position: 1, staffId: "901", quantity: 1 },
      { position: 0, staffId: "900", quantity: 2 },
      { position: 1, staffId: "900", quantity: 2 },
    ];
    assert.deepEqual(summarizeAttributedStaff(lines, { "900": " 山田  太郎 " }), [
      { staffId: "900", name: "山田 太郎", quantity: 4 },
      { staffId: "901", name: null, quantity: 1 },
    ]);
  });
  it("1 行にするときは「・」区切り、名前の無い人は ID で出す", () => {
    assert.equal(
      formatAttributedStaffList([
        { staffId: "900", name: "山田" },
        { staffId: "901", name: null },
      ]),
      "山田・スタッフ ID 901",
    );
    assert.equal(formatAttributedStaffList([]), "");
  });
});

describe("staffMemberDisplayName", () => {
  it("name を優先し、無ければ 姓 名", () => {
    assert.equal(staffMemberDisplayName({ name: "Yamada Taro", firstName: "Taro", lastName: "Yamada" }), "Yamada Taro");
    assert.equal(staffMemberDisplayName({ name: " ", firstName: "太郎", lastName: "山田" }), "山田 太郎");
    assert.equal(staffMemberDisplayName({ name: null }), null);
    assert.equal(staffMemberDisplayName(null), null);
  });
});

describe("スタッフ名の保存値", () => {
  it("空の行は捨て、名前を空にした行は登録を消す", () => {
    const { value, errors } = buildStaffDisplayNames([
      { staffId: "900", name: "山田" },
      { staffId: "901", name: "" },
      { staffId: "", name: "" },
      { staffId: "gid://shopify/StaffMember/902", name: " 佐藤 " },
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(value, { names: { "900": "山田", "902": "佐藤" } });
  });
  it("数字でない ID・同じ ID が 2 回・名前だけの行は行番号つきのエラー", () => {
    const { errors } = buildStaffDisplayNames([
      { staffId: "abc", name: "A" },
      { staffId: "900", name: "B" },
      { staffId: "0900", name: "C" },
      { staffId: "", name: "D" },
    ]);
    assert.deepEqual(errors.map((e) => e.row), [1, 3, 4]);
    assert.match(errors[1].message, /3 行目: スタッフ ID 900 が 2 回/);
  });
  it("読み直すときは形のおかしいものを捨てる", () => {
    assert.deepEqual(parseStaffDisplayNames({ names: { "900": "山田", x: "y", "901": "", "902": 3 } }), { names: { "900": "山田" } });
    assert.deepEqual(parseStaffDisplayNames(null), { names: {} });
    assert.deepEqual(parseStaffDisplayNames({ names: ["a"] }), { names: {} });
  });
});

describe("scopeIncludesReadUsers", () => {
  it("カンマ区切りのスコープに read_users があるか", () => {
    assert.equal(scopeIncludesReadUsers("read_orders,read_users"), true);
    assert.equal(scopeIncludesReadUsers("read_orders, write_users"), true);
    assert.equal(scopeIncludesReadUsers("read_orders,read_users_x"), false);
    assert.equal(scopeIncludesReadUsers(null), false);
  });
});
