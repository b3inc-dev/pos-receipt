import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REDACTED_RECIPIENT_NAME,
  redactCustomerData,
  type CustomerRedactDb,
} from "./customerRedact.server";

function fakeDb({ hasShop = true, failNotes = false } = {}) {
  const calls: Array<{ table: string; where: unknown; data?: unknown }> = [];
  const db: CustomerRedactDb = {
    shop: {
      findFirst: async (args) => {
        calls.push({ table: "shop", where: args.where });
        return hasShop ? { id: "s1" } : null;
      },
    },
    receiptIssue: {
      updateMany: async (args) => {
        calls.push({ table: "receiptIssue", where: args.where, data: args.data });
        return { count: 2 };
      },
    },
    specialRefundEvent: {
      updateMany: async (args) => {
        calls.push({ table: "specialRefundEvent", where: args.where, data: args.data });
        if (failNotes) throw new Error("db down");
        return { count: 1 };
      },
    },
  };
  return { db, calls };
}

const silent = () => {};

describe("redactCustomerData（customers/redact・T さん 11/23 2:35）", () => {
  it("領収書の宛名は空（[redacted] ではない）・特殊返金のメモは null。金額などの列は触らない", async () => {
    const { db, calls } = fakeDb();
    const r = await redactCustomerData({
      db,
      shopDomain: "example.myshopify.com",
      ordersToRedact: [1001],
      log: silent,
    });
    assert.deepEqual(r, { receiptIssuesRedacted: 2, specialRefundNotesDeleted: 1 });
    assert.equal(REDACTED_RECIPIENT_NAME, "");

    const receipt = calls.find((c) => c.table === "receiptIssue")!;
    assert.deepEqual(receipt.data, { recipientName: "" });
    const ids = ["1001", "gid://shopify/Order/1001"];
    assert.deepEqual(receipt.where, { shopId: "s1", orderId: { in: ids } });

    const note = calls.find((c) => c.table === "specialRefundEvent")!;
    assert.deepEqual(note.data, { note: null });
    assert.deepEqual(note.where, { shopId: "s1", sourceOrderId: { in: ids } });
  });

  it("注文が無い → 何もしない（DB を読まない）", async () => {
    const { db, calls } = fakeDb();
    const r = await redactCustomerData({ db, shopDomain: "a.myshopify.com", ordersToRedact: [], log: silent });
    assert.equal(r.skipped, "no_orders");
    assert.equal(calls.length, 0);
    const r2 = await redactCustomerData({ db, shopDomain: "a.myshopify.com", ordersToRedact: undefined, log: silent });
    assert.equal(r2.skipped, "no_orders");
  });

  it("店が無い → 何もしない", async () => {
    const { db, calls } = fakeDb({ hasShop: false });
    const r = await redactCustomerData({ db, shopDomain: "a.myshopify.com", ordersToRedact: [1], log: silent });
    assert.equal(r.skipped, "no_shop");
    assert.equal(calls.filter((c) => c.table !== "shop").length, 0);
  });

  it("DB の失敗は投げる（ルートが 500 → Shopify がもう一度送る）", async () => {
    const { db } = fakeDb({ failNotes: true });
    await assert.rejects(
      redactCustomerData({ db, shopDomain: "a.myshopify.com", ordersToRedact: [1], log: silent }),
      /db down/,
    );
  });

  it("記録（ログ）には件数だけ（宛名・メモの中身は出さない）", async () => {
    const { db } = fakeDb();
    const lines: string[] = [];
    await redactCustomerData({
      db,
      shopDomain: "a.myshopify.com",
      ordersToRedact: [1],
      log: (...a) => lines.push(a.join(" ")),
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /receiptIssues=2 specialRefundNotes=1/);
  });
});
