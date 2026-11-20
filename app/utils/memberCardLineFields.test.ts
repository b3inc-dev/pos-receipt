import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { customersQuery, getMemberIdByLineId } from "../lib/customer.server";
import {
  DEFAULT_LINE_ID_FIELDS,
  customerLineId,
  fullScanQuery,
  parseLineIdFields,
  readLineIdFields,
} from "./memberCardLineFields";

// 合成データだけを使う。本物の Shopify にはつながない。
const LINE_A = "U" + "a".repeat(32);
const LINE_B = "U" + "b".repeat(32);

type Customer = { id: string; tags: string[]; fields: Record<string, string>; memberId?: string };

/** customers の検索（tag: と metafields.<ns>.<key>:*）をまねる。呼んだ検索を残す。 */
function fakeAdmin(customers: Customer[]) {
  const searches: string[] = [];
  const tagged: unknown[] = [];
  const admin = {
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      const v = options?.variables ?? {};
      if (query.includes("tagsAdd")) {
        tagged.push(v);
        return new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [] } } }));
      }
      const search = String(v.query);
      searches.push(search);
      const tag = /^tag:"(.+)"$/.exec(search)?.[1];
      const meta = /^metafields\.([^.]+)\.([^:]+):\*$/.exec(search);
      const hits = customers.filter((c) => (tag ? c.tags.includes(tag) : meta ? Boolean(c.fields[`${meta[1]}.${meta[2]}`]) : false));
      const nodes = hits.map((c) => {
        const node: Record<string, unknown> = { id: c.id, metafield: c.memberId ? { value: c.memberId } : null };
        for (let i = 0; `lineNs${i}` in v; i += 1) {
          const value = c.fields[`${v[`lineNs${i}`]}.${v[`lineKey${i}`]}`];
          node[`lineField${i}`] = value ? { value } : null;
        }
        return node;
      });
      return new Response(JSON.stringify({ data: { customers: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }));
    },
  };
  return { admin: admin as unknown as Parameters<typeof getMemberIdByLineId>[0], searches, tagged };
}

describe("会員証が読む LINE ユーザー ID の項目", () => {
  it("既定は line_crm.line_user_id → socialplus.line。環境変数で並べ替えられ、形の合わないものと予約の namespace は捨てる", () => {
    assert.deepEqual(readLineIdFields({}), DEFAULT_LINE_ID_FIELDS);
    assert.deepEqual(parseLineIdFields("socialplus.line, line_crm.line_user_id"), [
      { namespace: "socialplus", key: "line" },
      { namespace: "line_crm", key: "line_user_id" },
    ]);
    assert.deepEqual(parseLineIdFields("$app:line.id,app--1.line,bad,crm.line,crm.line"), [{ namespace: "crm", key: "line" }]);
    assert.deepEqual(parseLineIdFields("bad"), DEFAULT_LINE_ID_FIELDS);
    assert.equal(fullScanQuery(DEFAULT_LINE_ID_FIELDS[0]), "metafields.line_crm.line_user_id:*");
    const query = customersQuery(DEFAULT_LINE_ID_FIELDS);
    assert.match(query, /lineField0: metafield\(namespace: \$lineNs0, key: \$lineKey0\)/);
    assert.match(query, /lineField1: metafield\(namespace: \$lineNs1, key: \$lineKey1\)/);
    assert.doesNotMatch(query, /"socialplus"/, "項目の名前は変数で渡す");
  });

  it("顧客の LINE ユーザー ID は、並べた順で最初に値が入っている項目（JSON の uid も読む）", () => {
    const fields = DEFAULT_LINE_ID_FIELDS;
    assert.equal(customerLineId({ lineField0: { value: LINE_A }, lineField1: { value: LINE_B } }, fields), LINE_A);
    assert.equal(customerLineId({ lineField0: null, lineField1: { value: JSON.stringify({ uid: LINE_B }) } }, fields), LINE_B);
    assert.equal(customerLineId({ lineField0: { value: " " }, lineField1: null }, fields), undefined);
  });

  it("LINE CRM の項目で見つけ、まだ埋めていない人は socialplus.line で見つける。タグのファストパスはそのまま", async () => {
    const shop = fakeAdmin([
      { id: "gid://shopify/Customer/1", tags: [], fields: { "line_crm.line_user_id": LINE_A }, memberId: "M1" },
      { id: "gid://shopify/Customer/2", tags: [], fields: { "socialplus.line": JSON.stringify({ uid: LINE_B }) }, memberId: "M2" },
    ]);
    const a = await getMemberIdByLineId(shop.admin, LINE_A, { sleep: async () => {} });
    assert.ok(a.ok && a.memberId === "M1");
    assert.deepEqual(shop.searches, [`tag:"line:${LINE_A.toLowerCase()}"`, "metafields.line_crm.line_user_id:*"]);
    const b = await getMemberIdByLineId(shop.admin, LINE_B, { sleep: async () => {} });
    assert.ok(b.ok && b.memberId === "M2");
    assert.deepEqual(shop.searches.slice(2), [`tag:"line:${LINE_B.toLowerCase()}"`, "metafields.line_crm.line_user_id:*", "metafields.socialplus.line:*"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(shop.tagged.length, 2, "見つけた人にタグを付ける");

    const tagged = fakeAdmin([{ id: "gid://shopify/Customer/3", tags: [`line:${LINE_A.toLowerCase()}`], fields: { "line_crm.line_user_id": LINE_A }, memberId: "M3" }]);
    const fast = await getMemberIdByLineId(tagged.admin, LINE_A, { sleep: async () => {} });
    assert.ok(fast.ok && fast.memberId === "M3");
    assert.equal(tagged.searches.length, 1, "タグで見つかれば全件は見ない");
  });

  it("LINE CRM の項目に別の ID があれば、古い socialplus.line やタグでは見つけない（連携し直した人・解除した人）", async () => {
    const shop = fakeAdmin([
      { id: "gid://shopify/Customer/1", tags: [`line:${LINE_B.toLowerCase()}`], fields: { "line_crm.line_user_id": LINE_A, "socialplus.line": LINE_B }, memberId: "M1" },
      // 解除した人: 項目は消えたがタグが残っている。
      { id: "gid://shopify/Customer/2", tags: [`line:${LINE_B.toLowerCase()}`], fields: {}, memberId: "M2" },
    ]);
    const result = await getMemberIdByLineId(shop.admin, LINE_B, { sleep: async () => {} });
    assert.deepEqual(result, { ok: false, error: "CUSTOMER_NOT_FOUND" });
  });

  it("会員番号が無ければ MEMBER_ID_NOT_SET、どの項目にもいなければ CUSTOMER_NOT_FOUND", async () => {
    const shop = fakeAdmin([{ id: "gid://shopify/Customer/1", tags: [], fields: { "socialplus.line": LINE_A } }]);
    assert.deepEqual(await getMemberIdByLineId(shop.admin, LINE_A, { sleep: async () => {} }), { ok: false, error: "MEMBER_ID_NOT_SET" });
    assert.deepEqual(await getMemberIdByLineId(fakeAdmin([]).admin, LINE_A, { sleep: async () => {} }), { ok: false, error: "CUSTOMER_NOT_FOUND" });
  });
});
