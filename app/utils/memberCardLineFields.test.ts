import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { customersQuery, getMemberIdByLineId } from "../lib/customer.server";
import { clearFieldFilterCache, lineFieldFilterState } from "../lib/memberCardFieldFilter.server";
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

type Definition = { enabled: boolean; status: string };
type FakeOptions = {
  /** `<ns>.<key>` → 定義。書かない項目は定義なし。既定は line_crm.line_user_id が絞り込みオン。 */
  definitions?: Record<string, Definition>;
  /** この検索は絞り込みを無視して全顧客を返す（2026-07 までの Shopify の動き）。 */
  ignoredFilters?: string[];
  /**
   * この検索はエラーになる（2026-10 からの Shopify の動き）。本物の client（@shopify/shopify-api の
   * GraphqlClient.request → throwFailedRequest）と同じく GraphqlQueryError を投げる。
   */
  erroringSearches?: string[];
  /** erroringSearches を投げずに本文の errors で返す（本文で返す client のとき）。 */
  errorsInBody?: boolean;
  /** この検索は 5xx・通信の切断で投げる（HttpResponseError など）。 */
  failingSearches?: string[];
  /** この検索はいつも Throttled で投げる。 */
  throttledSearches?: string[];
  /** 定義の問い合わせが例外になる。 */
  definitionThrows?: boolean;
};

const FILTERABLE: Definition = { enabled: true, status: "FILTERABLE" };

/** @shopify/shopify-api の GraphqlQueryError の形（name と message）をまねる。 */
class FakeGraphqlQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphqlQueryError";
  }
}

/** customers の検索（tag: と metafields.<ns>.<key>:*）と metafieldDefinitions をまねる。呼んだ検索を残す。 */
function fakeAdmin(customers: Customer[], opts: FakeOptions = {}) {
  const definitions = opts.definitions ?? { "line_crm.line_user_id": FILTERABLE };
  const searches: string[] = [];
  const definitionReads: string[] = [];
  const tagged: unknown[] = [];
  const admin = {
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      const v = options?.variables ?? {};
      if (query.includes("metafieldDefinitions(")) {
        const label = `${v.namespace}.${v.key}`;
        definitionReads.push(label);
        if (opts.definitionThrows) throw new Error("Throttled");
        const def = definitions[label];
        const nodes = def ? [{ namespace: v.namespace, key: v.key, capabilities: { adminFilterable: def } }] : [];
        return new Response(JSON.stringify({ data: { metafieldDefinitions: { nodes } } }));
      }
      if (query.includes("tagsAdd")) {
        tagged.push(v);
        return new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [] } } }));
      }
      const search = String(v.query);
      searches.push(search);
      if (opts.erroringSearches?.includes(search)) {
        const message = "Metafield definition does not allow filtering";
        if (opts.errorsInBody) return new Response(JSON.stringify({ errors: [{ message }] }));
        throw new FakeGraphqlQueryError(message);
      }
      if (opts.failingSearches?.includes(search)) throw new Error("Received an error response (502 Bad Gateway) from Shopify");
      if (opts.throttledSearches?.includes(search)) throw new FakeGraphqlQueryError("Throttled");
      const tag = /^tag:"(.+)"$/.exec(search)?.[1];
      const meta = /^metafields\.([^.]+)\.([^:]+):\*$/.exec(search);
      const ignored = opts.ignoredFilters?.includes(search);
      const hits = customers.filter((c) =>
        tag ? c.tags.includes(tag) : meta ? ignored || Boolean(c.fields[`${meta[1]}.${meta[2]}`]) : false
      );
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
  return { admin: admin as unknown as Parameters<typeof getMemberIdByLineId>[0], searches, definitionReads, tagged };
}

beforeEach(() => clearFieldFilterCache());

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

describe("全件スキャンは絞り込みが効く項目だけ（レビュー #36 の P1）", () => {
  const SHOP = "example.myshopify.com";
  const noop = async () => {};
  const people = (): Customer[] => [
    { id: "gid://shopify/Customer/1", tags: [], fields: { "line_crm.line_user_id": LINE_A }, memberId: "M1" },
    { id: "gid://shopify/Customer/2", tags: [], fields: { "socialplus.line": LINE_B }, memberId: "M2" },
    { id: "gid://shopify/Customer/3", tags: [], fields: {}, memberId: "M3" },
  ];

  it("定義が無い・絞り込みがオフ・処理中の項目は全件を見ず、socialplus.line は main と同じに見る", async () => {
    for (const definitions of [{}, { "line_crm.line_user_id": { enabled: false, status: "NOT_FILTERABLE" } }, { "line_crm.line_user_id": { enabled: true, status: "IN_PROGRESS" } }]) {
      clearFieldFilterCache();
      const shop = fakeAdmin(people(), { definitions });
      const b = await getMemberIdByLineId(shop.admin, LINE_B, { sleep: noop, shop: SHOP });
      assert.ok(b.ok && b.memberId === "M2");
      assert.deepEqual(shop.searches, [`tag:"line:${LINE_B.toLowerCase()}"`, "metafields.socialplus.line:*"]);
      assert.deepEqual(shop.definitionReads, ["line_crm.line_user_id"], "socialplus.line の定義は確かめない");
    }
  });

  it("定義の結果は店ごとに覚え、5 分のあいだは読み直さない", async () => {
    const shop = fakeAdmin(people());
    await getMemberIdByLineId(shop.admin, LINE_A, { sleep: noop, shop: SHOP });
    await getMemberIdByLineId(shop.admin, LINE_A, { sleep: noop, shop: SHOP });
    assert.deepEqual(shop.definitionReads, ["line_crm.line_user_id"]);
    await getMemberIdByLineId(shop.admin, LINE_A, { sleep: noop, shop: "other.myshopify.com" });
    assert.equal(shop.definitionReads.length, 2, "別の店は読み直す");
    const field = DEFAULT_LINE_ID_FIELDS[0];
    assert.equal(await lineFieldFilterState(shop.admin, SHOP, field, Date.now() + 5 * 60 * 1000 + 1), "usable");
    assert.equal(shop.definitionReads.length, 3, "5 分を過ぎたら読み直す");
  });

  it("2026-10 の API で検索がエラーになっても（client は GraphqlQueryError を投げる）、次の項目（socialplus.line）へ進む", async () => {
    const shop = fakeAdmin(people(), { erroringSearches: ["metafields.line_crm.line_user_id:*"] });
    const b = await getMemberIdByLineId(shop.admin, LINE_B, { sleep: noop, shop: SHOP });
    assert.ok(b.ok && b.memberId === "M2");
    assert.deepEqual(shop.searches.slice(1), ["metafields.line_crm.line_user_id:*", "metafields.socialplus.line:*"]);
    // どこにもいなければ、見られなかった項目があるので「見つからない」とは言わない。
    const none = await getMemberIdByLineId(shop.admin, "U" + "c".repeat(32), { sleep: noop, shop: SHOP });
    assert.deepEqual(none, { ok: false, error: "API_ERROR" });
  });

  it("本文で errors を返す client でも同じく次の項目へ進む", async () => {
    const shop = fakeAdmin(people(), { erroringSearches: ["metafields.line_crm.line_user_id:*"], errorsInBody: true });
    const b = await getMemberIdByLineId(shop.admin, LINE_B, { sleep: noop, shop: SHOP });
    assert.ok(b.ok && b.memberId === "M2");
    assert.deepEqual(shop.searches.slice(1), ["metafields.line_crm.line_user_id:*", "metafields.socialplus.line:*"]);
  });

  it("5xx・通信の切断で投げても次の項目へ進み、どこにもいなければ API_ERROR", async () => {
    const shop = fakeAdmin(people(), { failingSearches: ["metafields.line_crm.line_user_id:*"] });
    const b = await getMemberIdByLineId(shop.admin, LINE_B, { sleep: noop, shop: SHOP });
    assert.ok(b.ok && b.memberId === "M2");
    const a = await getMemberIdByLineId(shop.admin, LINE_A, { sleep: noop, shop: SHOP });
    assert.deepEqual(a, { ok: false, error: "API_ERROR" }, "line_crm にいる人を「連携していない」と言わない");
  });

  it("Throttled を使い切ったら次へ進まず THROTTLED（前と同じ）", async () => {
    const shop = fakeAdmin(people(), { throttledSearches: ["metafields.line_crm.line_user_id:*"] });
    const b = await getMemberIdByLineId(shop.admin, LINE_B, { sleep: noop, shop: SHOP });
    assert.deepEqual(b, { ok: false, error: "THROTTLED" });
    assert.ok(!shop.searches.includes("metafields.socialplus.line:*"));
  });

  it("socialplus.line の検索が投げても本文で errors を返しても、ほかで見つからなければ main と同じく API_ERROR", async () => {
    for (const errorsInBody of [false, true]) {
      const shop = fakeAdmin(people(), { erroringSearches: ["metafields.socialplus.line:*"], errorsInBody });
      assert.deepEqual(await getMemberIdByLineId(shop.admin, LINE_B, { sleep: noop, shop: SHOP }), { ok: false, error: "API_ERROR" });
      const a = await getMemberIdByLineId(shop.admin, LINE_A, { sleep: noop, shop: SHOP });
      assert.ok(a.ok && a.memberId === "M1", "先の項目で見つかればそのまま返す");
    }
    const legacyOnly = fakeAdmin(people(), { failingSearches: ["metafields.socialplus.line:*"] });
    assert.deepEqual(
      await getMemberIdByLineId(legacyOnly.admin, LINE_B, { sleep: noop, shop: SHOP, fields: parseLineIdFields("socialplus.line") }),
      { ok: false, error: "API_ERROR" }
    );
  });

  it("定義はオンでも絞り込みが無視されて値の空の人が返ったら、その項目の全件は打ち切り、しばらく見ない", async () => {
    // 値の空の人を先頭に置いて、絞り込みが無視されたことを 1 ページめで見つける。
    const list = [people()[2], people()[0], people()[1]];
    const shop = fakeAdmin(list, { ignoredFilters: ["metafields.line_crm.line_user_id:*"] });
    const a = await getMemberIdByLineId(shop.admin, LINE_A, { sleep: noop, shop: SHOP });
    // line_crm の項目は打ち切ったので見つからない。socialplus.line にもいない。
    assert.deepEqual(a, { ok: false, error: "CUSTOMER_NOT_FOUND" });
    assert.deepEqual(shop.searches.slice(1), ["metafields.line_crm.line_user_id:*", "metafields.socialplus.line:*"]);
    await getMemberIdByLineId(shop.admin, LINE_A, { sleep: noop, shop: SHOP });
    assert.deepEqual(shop.searches.slice(4), ["metafields.socialplus.line:*"], "次からは line_crm の全件を見ない");
    assert.equal(shop.definitionReads.length, 1);
  });

  it("定義を読めないときはその項目を見ず、覚えない。どこにもいなければ API_ERROR", async () => {
    const shop = fakeAdmin(people(), { definitionThrows: true });
    const b = await getMemberIdByLineId(shop.admin, LINE_B, { sleep: noop, shop: SHOP });
    assert.ok(b.ok && b.memberId === "M2");
    const a = await getMemberIdByLineId(shop.admin, LINE_A, { sleep: noop, shop: SHOP });
    assert.deepEqual(a, { ok: false, error: "API_ERROR" });
    assert.equal(shop.definitionReads.length, 2, "読めなかった結果は覚えない");
  });

  it("MEMBER_CARD_LINE_ID_METAFIELDS=socialplus.line なら、前と同じ動き（定義を確かめない）", async () => {
    const shop = fakeAdmin(people(), { definitions: {} });
    const b = await getMemberIdByLineId(shop.admin, LINE_B, { sleep: noop, shop: SHOP, fields: parseLineIdFields("socialplus.line") });
    assert.ok(b.ok && b.memberId === "M2");
    assert.deepEqual(shop.definitionReads, []);
    assert.deepEqual(shop.searches.slice(1), ["metafields.socialplus.line:*"]);
  });
});
