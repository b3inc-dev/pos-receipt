/**
 * 上流 API の内部エラー・タイムアウト時に、不完全な注文ページを確定しない。
 * 合成レスポンスのみ。実店舗データは使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  readOrdersPageOrThrow,
  UPSTREAM_AGGREGATION_FAILURE_MESSAGE,
  UpstreamAggregationError,
} from "./settlementUpstreamPage.server";

const SECRET = "gid://shopify/Order/999001";

function orderNode(id: string) {
  return { id, total: 1000 };
}

function okPage(ids: string[], hasNextPage: boolean, endCursor: string | null) {
  return {
    data: {
      orders: {
        nodes: ids.map(orderNode),
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

function errorPage(
  code: string,
  partialIds: string[] = [],
) {
  return {
    errors: [
      {
        message: `Internal error while reading ${SECRET}`,
        extensions: { code },
      },
    ],
    data: partialIds.length
      ? {
          orders: {
            nodes: partialIds.map(orderNode),
            pageInfo: { hasNextPage: true, endCursor: "cursor-partial" },
          },
        }
      : null,
  };
}

/** 修正前の fetchAllOrders と同じ受け取り方。エラーを見ず、pageInfo が無ければ終端扱い。 */
function legacyAcceptPage(json: {
  data?: { orders?: { nodes?: { id: string }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } | null;
}) {
  const nodes = json.data?.orders?.nodes ?? [];
  const pageInfo = json.data?.orders?.pageInfo;
  return {
    ids: nodes.map((n) => n.id),
    hasNextPage: pageInfo?.hasNextPage ?? false,
    endCursor: pageInfo?.endCursor ?? null,
  };
}

describe("readOrdersPageOrThrow", () => {
  it("空の暦日は nodes 空かつ次ページなしとして受け付ける", () => {
    const page = readOrdersPageOrThrow(okPage([], false, null), "settlementOrders");
    assert.deepEqual(page.nodes, []);
    assert.equal(page.hasNextPage, false);
  });

  it("次ページがある完全なページは cursor を返す", () => {
    const page = readOrdersPageOrThrow(okPage(["order-a"], true, "cursor-2"), "settlementOrders");
    assert.equal(page.nodes.length, 1);
    assert.equal(page.hasNextPage, true);
    assert.equal(page.endCursor, "cursor-2");
  });

  it("INTERNAL_SERVER_ERROR では部分 nodes を返さず、応答本文を利用者向け文言に含めない", () => {
    const payload = errorPage("INTERNAL_SERVER_ERROR", ["order-a"]);
    const legacy = legacyAcceptPage(payload);
    assert.deepEqual(legacy.ids, ["order-a"]);
    assert.equal(legacy.hasNextPage, true);

    assert.throws(
      () => readOrdersPageOrThrow(payload, "settlementOrders"),
      (err: unknown) => {
        assert.ok(err instanceof UpstreamAggregationError);
        assert.equal(err.code, "UPSTREAM_INCOMPLETE");
        assert.equal(err.message, UPSTREAM_AGGREGATION_FAILURE_MESSAGE);
        assert.equal(err.message.includes(SECRET), false);
        assert.equal(err.message.includes("INTERNAL_SERVER_ERROR"), false);
        return true;
      },
    );
  });

  it("data が null の TIMEOUT を空の成功にしない", () => {
    const payload = errorPage("TIMEOUT");
    const legacy = legacyAcceptPage(payload);
    assert.deepEqual(legacy.ids, []);
    assert.equal(legacy.hasNextPage, false);
    assert.throws(() => readOrdersPageOrThrow(payload, "settlementOrders"), UpstreamAggregationError);
  });

  it("pageInfo が欠けると打ち切って確定しない", () => {
    const payload = { data: { orders: { nodes: [orderNode("order-a")] } } };
    const legacy = legacyAcceptPage(payload);
    assert.deepEqual(legacy.ids, ["order-a"]);
    assert.equal(legacy.hasNextPage, false);
    assert.throws(() => readOrdersPageOrThrow(payload, "settlementOrders"), UpstreamAggregationError);
  });

  it("hasNextPage なのに cursor が無い場合は進めない", () => {
    const payload = okPage(["order-a"], true, "");
    assert.throws(() => readOrdersPageOrThrow(payload, "settlementOrders"), UpstreamAggregationError);
  });
});

describe("集計の確定と再試行", () => {
  function bodyFor(ids: string[], hasNextPage: boolean, endCursor: string | null) {
    return okPage(ids, hasNextPage, endCursor);
  }

  async function run(payloads: unknown[], committed: { ids: string[] | null }) {
    const ids: string[] = [];
    let i = 0;
    let hasNextPage = true;
    while (hasNextPage) {
      const json = payloads[i++];
      if (json instanceof Error) throw json;
      const page = readOrdersPageOrThrow(json, "settlementOrders");
      for (const node of page.nodes as { id: string }[]) ids.push(node.id);
      hasNextPage = page.hasNextPage;
    }
    committed.ids = ids;
  }

  it("2ページ目の内部エラーでは確定済みの集計を上書きしない", async () => {
    const committed = { ids: ["previous-complete"] };
    await assert.rejects(
      () =>
        run(
          [
            bodyFor(["order-a"], true, "cursor-2"),
            errorPage("INTERNAL_SERVER_ERROR", ["order-b"]),
          ],
          committed,
        ),
      UpstreamAggregationError,
    );
    assert.deepEqual(committed.ids, ["previous-complete"]);
  });

  it("2ページ目のタイムアウト例外でも確定済みの集計を上書きしない", async () => {
    const committed = { ids: ["previous-complete"] };
    await assert.rejects(
      () =>
        run(
          [bodyFor(["order-a"], true, "cursor-2"), new Error("socket timeout")],
          committed,
        ),
      (err: unknown) => err instanceof Error && err.message === "socket timeout",
    );
    assert.deepEqual(committed.ids, ["previous-complete"]);
  });

  it("失敗のあと全ページが揃った再試行だけが集計を置き換える", async () => {
    const committed = { ids: ["previous-complete"] };
    await assert.rejects(
      () =>
        run(
          [bodyFor(["order-a"], true, "cursor-2"), errorPage("TIMEOUT")],
          committed,
        ),
      UpstreamAggregationError,
    );
    assert.deepEqual(committed.ids, ["previous-complete"]);

    await run(
      [
        bodyFor(["order-a"], true, "cursor-2"),
        bodyFor(["order-b", "order-c"], false, null),
      ],
      committed,
    );
    assert.deepEqual(committed.ids, ["order-a", "order-b", "order-c"]);
  });

  it("注文が無い日は空の集計として確定できる", async () => {
    const committed = { ids: null };
    await run([bodyFor([], false, null)], committed);
    assert.deepEqual(committed.ids, []);
  });
});

describe("精算取得がガードを通る", () => {
  it("注文ページ取得の2箇所で readOrdersPageOrThrow を呼ぶ", () => {
    const src = readFileSync(new URL("./settlementEngine.server.ts", import.meta.url), "utf8");
    const calls = src.match(/readOrdersPageOrThrow\(json,/g) ?? [];
    assert.equal(calls.length, 2);
  });
});
