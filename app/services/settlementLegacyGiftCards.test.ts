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

  it("2ページ目で通信の例外が出たら、そのまま止める", async () => {
    const { admin } = fakeAdmin([
      okPage([card("1", 1000)], true, "c-1"),
      () => {
        throw new UpstreamAggregationError(LEGACY_GIFT_CARD_FAILURE_MESSAGE);
      },
    ]);
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
