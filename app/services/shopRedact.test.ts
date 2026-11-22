import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactShopData, type ShopRedactDb } from "./shopRedact.server";

function fakeDb({ hasShop = true, failUsage = false } = {}) {
  const calls: string[] = [];
  const db: ShopRedactDb = {
    appUsageReport: {
      deleteMany: async (args) => {
        calls.push(`usage:${args.where.shop}`);
        if (failUsage) throw new Error("db down");
        return { count: 3 };
      },
    },
    session: {
      deleteMany: async (args) => {
        calls.push(`session:${args.where.shop}`);
        return { count: 2 };
      },
    },
    shop: {
      findFirst: async (args) => {
        calls.push(`find:${args.where.shopDomain}`);
        return hasShop ? { id: "s1" } : null;
      },
      delete: async (args) => {
        calls.push(`delete:${args.where.id}`);
        return {};
      },
    },
  };
  return { db, calls };
}

const quiet = () => {};

describe("redactShopData", () => {
  it("使用量の記録・セッション・Shop の行をその店の分だけ消す", async () => {
    const { db, calls } = fakeDb();
    const res = await redactShopData({ db, shopDomain: "a.myshopify.com", log: quiet });
    assert.deepEqual(calls, ["usage:a.myshopify.com", "session:a.myshopify.com", "find:a.myshopify.com", "delete:s1"]);
    assert.deepEqual(res, { usageReportsDeleted: 3, sessionsDeleted: 2, shopDeleted: true });
  });

  it("Shop の行が無くても使用量の記録とセッションは消す（何度来ても安全）", async () => {
    const { db, calls } = fakeDb({ hasShop: false });
    const res = await redactShopData({ db, shopDomain: "a.myshopify.com", log: quiet });
    assert.deepEqual(calls, ["usage:a.myshopify.com", "session:a.myshopify.com", "find:a.myshopify.com"]);
    assert.equal(res.shopDeleted, false);
  });

  it("店のドメインが無いときは何も消さない", async () => {
    const { db, calls } = fakeDb();
    const res = await redactShopData({ db, shopDomain: "  ", log: quiet });
    assert.equal(res.skipped, "no_shop");
    assert.deepEqual(calls, []);
  });

  it("消すのに失敗したら投げる（Shopify にもう一度送ってもらう）。ほかは消さない", async () => {
    const { db, calls } = fakeDb({ failUsage: true });
    await assert.rejects(redactShopData({ db, shopDomain: "a.myshopify.com", log: quiet }), /db down/);
    assert.deepEqual(calls, ["usage:a.myshopify.com"]);
  });

  it("記録には件数だけを出す", async () => {
    const { db } = fakeDb();
    const lines: string[] = [];
    await redactShopData({ db, shopDomain: "a.myshopify.com", log: (...a) => lines.push(a.join(" ")) });
    assert.deepEqual(lines, ["[webhooks.compliance] shop/redact shop=a.myshopify.com usageReports=3 sessions=2 shopRow=1"]);
  });
});
