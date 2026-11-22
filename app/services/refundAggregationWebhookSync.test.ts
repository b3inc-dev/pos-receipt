/**
 * orders/updated のキュー経路でも返金計上店（pos.refund_aggregation_location_gid）を書くことのテスト
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { syncRefundAggregationForQueuedWebhook } from "./refundAggregationWebhookSync.server";

const here = dirname(fileURLToPath(import.meta.url));

describe("syncRefundAggregationForQueuedWebhook", () => {
  it("admin・shopId・payload をそのまま書き込み関数に渡し、true を返す", async () => {
    const calls: unknown[][] = [];
    const admin = { tag: "admin" };
    const payload = { id: 123, refunds: [{ id: 1 }] };
    const ok = await syncRefundAggregationForQueuedWebhook(
      async (a, s, p) => {
        calls.push([a, s, p]);
      },
      admin,
      "shop-db-id",
      "example.myshopify.com",
      payload,
    );
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], admin);
    assert.equal(calls[0][1], "shop-db-id");
    assert.equal(calls[0][2], payload);
  });

  it("書き込みが失敗しても投げず、店のドメイン付きでログを出して false を返す", async () => {
    const warns: { message: string; err: unknown }[] = [];
    const boom = new Error("metafieldsSet failed");
    const ok = await syncRefundAggregationForQueuedWebhook(
      async () => {
        throw boom;
      },
      {},
      "shop-db-id",
      "example.myshopify.com",
      {},
      { warn: (message, err) => warns.push({ message, err }) },
    );
    assert.equal(ok, false);
    assert.equal(warns.length, 1);
    assert.match(warns[0].message, /refund aggregation metafield sync failed/);
    assert.match(warns[0].message, /shop=example\.myshopify\.com/);
    assert.equal(warns[0].err, boom);
  });
});

describe("salesSummaryWebhookQueue のワーカー", () => {
  // ワーカー本体は pg-boss の中にあり単体で動かせないため、つなぎ込みをソースで確かめる。
  const src = readFileSync(join(here, "salesSummaryWebhookQueue.server.ts"), "utf8");

  it("同期経路と同じ syncRefundAggregationFromWebhookPayload を使う", () => {
    assert.match(
      src,
      /import \{ syncRefundAggregationFromWebhookPayload \} from "\.\/refundAggregation\.server";/,
    );
    assert.match(
      src,
      /syncRefundAggregationForQueuedWebhook\(\s*syncRefundAggregationFromWebhookPayload,\s*admin,\s*dbShop\.id,\s*shopDomain,\s*payload,\s*\)/,
    );
  });

  it("売上サマリーの再計算より先に書く（再計算の失敗・再試行で書き漏れないように）", () => {
    const syncAt = src.indexOf("await syncRefundAggregationForQueuedWebhook(");
    const summaryAt = src.indexOf("await executeSalesSummaryOrderWebhookJob(");
    const disabledAt = src.indexOf('if (disabled === "1" || disabled === "true") continue;');
    assert.ok(syncAt > 0 && summaryAt > 0 && disabledAt > 0);
    assert.ok(disabledAt < syncAt, "再計算 OFF のときは同期経路と同じく書かない");
    assert.ok(syncAt < summaryAt);
  });
});
