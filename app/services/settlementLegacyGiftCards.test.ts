/**
 * 旧ギフトカード（商品券）発行の取得が途中で失敗したとき、途中までの額で精算を確定しない。
 * 合成レスポンスのみ。実店舗データは使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  classifyGiftCardsPage,
  fetchLegacyGiftCardIssuanceForDay,
} from "./settlementLegacyGiftCards.server";
import {
  LEGACY_GIFT_CARD_FAILURE_MESSAGE,
  UpstreamAggregationError,
} from "./settlementUpstreamPage.server";

const LOCATION_ID = "gid://shopify/Location/111";
const DAY = {
  startUtc: new Date("2026-11-18T15:00:00.000Z"),
  endUtc: new Date("2026-11-19T14:59:59.999Z"),
  startUtcIso: "2026-11-18T15:00:00.000Z",
  endUtcIso: "2026-11-19T14:59:59.999Z",
};

function card(id: string, amount: number, createdAt = "2026-11-19T03:00:00.000Z") {
  return {
    cursor: `c-${id}`,
    node: {
      id: `gid://shopify/GiftCard/${id}`,
      createdAt,
      note: null,
      initialValue: { amount: String(amount), currencyCode: "JPY" },
      order: { id: `gid://shopify/Order/${id}`, retailLocation: { id: LOCATION_ID } },
    },
  };
}

function okPage(cards: ReturnType<typeof card>[], hasNextPage: boolean, endCursor: string | null) {
  return { data: { giftCards: { edges: cards, pageInfo: { hasNextPage, endCursor } } } };
}

function errorPage(code: string) {
  return { errors: [{ message: "Internal error", extensions: { code } }], data: null };
}

/** @shopify/shopify-app-react-router の admin.graphql が errors のときに投げる例外に似せたもの */
class FakeGraphqlQueryError extends Error {
  body = { errors: [{ message: "Access denied for giftCards field.", extensions: { code: "ACCESS_DENIED" } }] };
  constructor() {
    super("GraphQL Client: An error occurred while fetching from the API. Review 'graphQLErrors' for details.");
    this.name = "GraphqlQueryError";
  }
}
function graphqlQueryError(): never {
  throw new FakeGraphqlQueryError();
}

/** 呼ばれた順に応答を返す偽の admin。応答が関数なら呼び出して投げさせる。 */
function fakeAdmin(responses: unknown[]) {
  const calls: { query: string; after: unknown }[] = [];
  const admin = {
    graphql: async (query: string, opts?: object) => {
      const vars = (opts as { variables?: { after?: unknown } } | undefined)?.variables;
      calls.push({ query, after: vars?.after ?? null });
      const next = responses.shift();
      if (typeof next === "function") (next as () => never)();
      if (next === undefined) throw new Error("unexpected call");
      return { json: async () => next };
    },
  };
  return { admin, calls };
}

function run(admin: ReturnType<typeof fakeAdmin>["admin"]) {
  return fetchLegacyGiftCardIssuanceForDay(admin, DAY as never, LOCATION_ID, "本店", new Set());
}

async function assertFailClosed(p: Promise<unknown>) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof UpstreamAggregationError);
    assert.equal((err as UpstreamAggregationError).code, "UPSTREAM_INCOMPLETE");
    assert.equal((err as Error).message, LEGACY_GIFT_CARD_FAILURE_MESSAGE);
    assert.ok(!(err as Error).message.includes("GraphQL Client"));
    assert.ok((err as Error).message.includes("旧ギフトカード API 集計（検証用・既定 OFF）"));
    return true;
  });
}

describe("classifyGiftCardsPage", () => {
  it("完全なページは edges と cursor を返す", () => {
    const page = classifyGiftCardsPage(okPage([card("1", 1000)], true, "c-1"));
    assert.notEqual(typeof page, "string");
    if (typeof page === "string") return;
    assert.equal(page.edges.length, 1);
    assert.equal(page.endCursor, "c-1");
  });

  it("errors があれば graphql-error", () => {
    assert.equal(classifyGiftCardsPage(errorPage("INTERNAL_SERVER_ERROR")), "graphql-error");
  });

  it("giftCards・pageInfo・cursor が欠けたら invalid", () => {
    assert.equal(classifyGiftCardsPage({ data: null }), "invalid");
    assert.equal(classifyGiftCardsPage({ data: { giftCards: { edges: [] } } }), "invalid");
    assert.equal(classifyGiftCardsPage(okPage([], true, null)), "invalid");
    assert.equal(classifyGiftCardsPage(null), "invalid");
  });
});

describe("fetchLegacyGiftCardIssuanceForDay", () => {
  it("全ページ揃えば合計する", async () => {
    const { admin } = fakeAdmin([
      okPage([card("1", 1000)], true, "c-1"),
      okPage([card("2", 3000)], false, null),
    ]);
    assert.deepEqual(await run(admin), { amount: 4000, count: 2 });
  });

  it("発行が無い日は 0 円として確定できる", async () => {
    const { admin } = fakeAdmin([okPage([], false, null)]);
    assert.deepEqual(await run(admin), { amount: 0, count: 0 });
  });

  it("2ページ目で data が欠けたら、1ページ目の額だけで確定しない", async () => {
    const { admin } = fakeAdmin([okPage([card("1", 1000)], true, "c-1"), { data: null }]);
    await assertFailClosed(run(admin));
  });

  it("2ページ目で例外が出て、代わりのクエリも例外なら、日本語の案内で止める", async () => {
    const { admin, calls } = fakeAdmin([
      okPage([card("1", 1000)], true, "c-1"),
      graphqlQueryError,
      graphqlQueryError,
    ]);
    await assertFailClosed(run(admin));
    assert.equal(calls.length, 3);
  });

  it("本物のクライアントのように errors を例外（GraphqlQueryError）で投げても、代わりのクエリへ回る", async () => {
    const { admin, calls } = fakeAdmin([
      graphqlQueryError,
      okPage([card("1", 1000), card("2", 3000)], false, null),
    ]);
    assert.deepEqual(await run(admin), { amount: 4000, count: 2 });
    assert.equal(calls.length, 2);
    assert.ok(!calls[0].query.includes("LegacyGiftCardsFb"));
    assert.ok(calls[1].query.includes("LegacyGiftCardsFb"));
  });

  it("権限が無い店（両方のクエリが ACCESS_DENIED の例外）は、英語の生のエラーではなく日本語の案内で止める", async () => {
    const { admin } = fakeAdmin([graphqlQueryError, graphqlQueryError]);
    await assertFailClosed(run(admin));
  });

  it("主クエリが errors のときは代わりのクエリで最初から数え直す（途中の額を足さない）", async () => {
    const { admin, calls } = fakeAdmin([
      okPage([card("1", 1000)], true, "c-1"),
      errorPage("INTERNAL_SERVER_ERROR"),
      okPage([card("1", 1000), card("2", 3000)], false, null),
    ]);
    assert.deepEqual(await run(admin), { amount: 4000, count: 2 });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].after, null);
  });

  it("代わりのクエリも errors なら 0 円で確定しない（以前は 0 円を返していた）", async () => {
    const { admin } = fakeAdmin([errorPage("INTERNAL_SERVER_ERROR"), errorPage("INTERNAL_SERVER_ERROR")]);
    await assertFailClosed(run(admin));
  });

  it("代わりのクエリの途中で pageInfo が欠けたら確定しない", async () => {
    const { admin } = fakeAdmin([
      errorPage("INTERNAL_SERVER_ERROR"),
      okPage([card("1", 1000)], true, "c-1"),
      { data: { giftCards: { edges: [card("2", 3000)] } } },
    ]);
    await assertFailClosed(run(admin));
  });
});

describe("settlementEngine の旧ギフトカード集計", () => {
  it("取得の失敗を握りつぶさない（try/catch で包まない）", () => {
    const src = readFileSync(new URL("./settlementEngine.server.ts", import.meta.url), "utf8");
    const start = src.indexOf("if (legacyGiftOn) {");
    assert.ok(start > 0);
    const block = src.slice(start, src.indexOf("computeGasSettlementTxTimeBounds", start));
    assert.ok(block.includes("fetchLegacyGiftCardIssuanceForDay"));
    assert.ok(!block.includes("catch"), "旧ギフトカード集計の失敗を catch で捨てている");
  });
});

describe("案内の文と設定画面の表示名", () => {
  it("案内に出す設定名は、精算設定の画面の表示名と同じ", () => {
    const page = readFileSync(new URL("../routes/app.settlement-settings.tsx", import.meta.url), "utf8");
    const m = LEGACY_GIFT_CARD_FAILURE_MESSAGE.match(/「([^」]+)」/);
    assert.ok(m);
    assert.ok(page.includes(`label="${m![1]}"`), `画面に「${m![1]}」が無い`);
  });

  it("Throttled の使い切りは案内に変えずそのまま上げる（混雑しています を出すため）", () => {
    const src = readFileSync(new URL("./settlementLegacyGiftCards.server.ts", import.meta.url), "utf8");
    assert.ok(src.includes("if (err instanceof ThrottledExhaustedError || isThrottledError(err)) throw err;"));
  });
});
