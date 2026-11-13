/**
 * 日次売上のバックグラウンド再計算で、一部スライスだけ上流が失敗する合成ケース。
 * 途中ページは完成値にせず、既存の確定値を残し、再試行は置換する。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  backgroundRefreshNeedsRetry,
  runBackgroundDailySlices,
} from "./salesSummaryBackgroundSlice.server";
import {
  readOrdersPageOrThrow,
  UpstreamAggregationError,
} from "./settlementUpstreamPage.server";

type Daily = { ids: string[] };

function page(ids: string[], hasNextPage: boolean, endCursor: string | null) {
  return {
    data: {
      orders: {
        nodes: ids.map((id) => ({ id })),
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

function upstreamError(partialIds: string[]) {
  return {
    errors: [{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
    data: {
      orders: {
        nodes: partialIds.map((id) => ({ id })),
        pageInfo: { hasNextPage: true, endCursor: "cursor-partial" },
      },
    },
  };
}

/** 本番のページループと同じく、全ページが揃ったときだけ ID を返す。 */
async function loadOrderIds(pages: unknown[]): Promise<string[]> {
  const ids: string[] = [];
  let index = 0;
  let hasNextPage = true;
  while (hasNextPage) {
    const current = pages[index++];
    if (current instanceof Error) throw current;
    const loaded = readOrdersPageOrThrow(current, "backgroundDaily");
    for (const node of loaded.nodes as { id: string }[]) ids.push(node.id);
    hasNextPage = loaded.hasNextPage;
  }
  return ids;
}

function deliver(saved: Map<string, Daily>): string[] {
  return [...saved.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, row]) => row.ids);
}

describe("バックグラウンド日次の一部失敗", () => {
  it("失敗したロケーションは途中 ID を保存・配信せず、成功分と既存確定値だけを残す", async () => {
    const saved = new Map<string, Daily>([
      ["loc-a", { ids: ["old-a"] }],
      ["loc-b", { ids: ["old-b1", "old-b2"] }],
    ]);

    const replaceIfComplete = (key: string, pages: unknown[]) => async () => {
      const ids = await loadOrderIds(pages);
      saved.set(key, { ids });
    };

    const { errors } = await runBackgroundDailySlices([
      {
        label: "loc-a 2026-11-01",
        run: replaceIfComplete("loc-a", [
          page(["a1"], true, "cursor-2"),
          page(["a2"], false, null),
        ]),
      },
      {
        label: "loc-b 2026-11-01",
        run: replaceIfComplete("loc-b", [
          page(["b-partial"], true, "cursor-2"),
          upstreamError(["b-partial-2"]),
        ]),
      },
    ]);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /loc-b 2026-11-01/);
    assert.equal(errors[0].includes("b-partial"), false);
    assert.deepEqual(saved.get("loc-a")?.ids, ["a1", "a2"]);
    assert.deepEqual(saved.get("loc-b")?.ids, ["old-b1", "old-b2"]);
    assert.deepEqual(deliver(saved), ["a1", "a2", "old-b1", "old-b2"]);
    assert.equal(deliver(saved).includes("b-partial"), false);
    assert.equal(backgroundRefreshNeedsRetry(errors), true);
  });

  it("再試行は失敗分を一度だけ置換し、成功済みスライスを加算しない", async () => {
    const saved = new Map<string, Daily>([
      ["loc-a", { ids: ["a1", "a2"] }],
      ["loc-b", { ids: ["old-b1", "old-b2"] }],
    ]);
    const replaceIfComplete = (key: string, pages: unknown[]) => async () => {
      const ids = await loadOrderIds(pages);
      saved.set(key, { ids });
    };

    const fullA = [
      page(["a1"], true, "cursor-2"),
      page(["a2"], false, null),
    ];
    const fullB = [
      page(["b1"], true, "cursor-2"),
      page(["b2", "b3"], false, null),
    ];

    const { errors } = await runBackgroundDailySlices([
      { label: "loc-a", run: replaceIfComplete("loc-a", fullA) },
      { label: "loc-b", run: replaceIfComplete("loc-b", fullB) },
    ]);

    assert.deepEqual(errors, []);
    assert.equal(backgroundRefreshNeedsRetry(errors), false);
    assert.deepEqual(saved.get("loc-a")?.ids, ["a1", "a2"]);
    assert.deepEqual(saved.get("loc-b")?.ids, ["b1", "b2", "b3"]);
    assert.deepEqual(deliver(saved), ["a1", "a2", "b1", "b2", "b3"]);
  });

  it("タイムアウト例外でも既存確定値を残し、空の暦日はゼロ件として置換する", async () => {
    const saved = new Map<string, Daily>([
      ["loc-a", { ids: ["old-a"] }],
      ["loc-b", { ids: ["old-b"] }],
    ]);
    const replaceIfComplete = (key: string, pages: unknown[]) => async () => {
      const ids = await loadOrderIds(pages);
      saved.set(key, { ids });
    };

    const failed = await runBackgroundDailySlices([
      {
        label: "loc-a",
        run: replaceIfComplete("loc-a", [
          page(["a-partial"], true, "cursor-2"),
          new Error("socket timeout"),
        ]),
      },
    ]);
    assert.equal(failed.errors.length, 1);
    assert.deepEqual(saved.get("loc-a")?.ids, ["old-a"]);

    const empty = await runBackgroundDailySlices([
      { label: "loc-b", run: replaceIfComplete("loc-b", [page([], false, null)]) },
    ]);
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(saved.get("loc-b")?.ids, []);
  });

  it("上流エラーは UpstreamAggregationError で、チャネルと精算のページ取得が同じガードを通る", () => {
    assert.throws(
      () => readOrdersPageOrThrow(upstreamError(["x"]), "channelOrders"),
      UpstreamAggregationError,
    );
    const channel = readFileSync(new URL("./salesChannelEngine.server.ts", import.meta.url), "utf8");
    const settlement = readFileSync(new URL("./settlementEngine.server.ts", import.meta.url), "utf8");
    const refresh = readFileSync(new URL("./salesSummaryWebhookRefresh.server.ts", import.meta.url), "utf8");
    const queue = readFileSync(new URL("./salesSummaryWebhookQueue.server.ts", import.meta.url), "utf8");
    const webhook = readFileSync(new URL("../routes/webhooks.orders.updated.tsx", import.meta.url), "utf8");
    assert.equal((channel.match(/readOrdersPageOrThrow\(json,/g) ?? []).length, 2);
    assert.equal((settlement.match(/readOrdersPageOrThrow\(json,/g) ?? []).length, 2);
    assert.equal(refresh.includes("runBackgroundDailySlices("), true);
    assert.equal(queue.includes("backgroundRefreshNeedsRetry("), true);
    assert.equal(webhook.includes("backgroundRefreshNeedsRetry("), true);
  });
});
