/**
 * レビュー P2-5: planCode が Pro なのに契約が無い店の一覧（読むだけ）のテスト。合成データだけ。本物にはつながない。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPlanMismatchReport,
  classifyShop,
  formatPlanMismatchReport,
  readAdminSubscriptions,
  readPartnerConfigForReport,
} from "./planMismatch.mjs";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const FUTURE = new Date(NOW + 3600_000);
const PAST = new Date(NOW - 1000);

function adminFetch(byShop) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const shop = new URL(url).host;
    const v = byShop[shop];
    if (v === undefined) return { status: 500, json: async () => ({}) };
    if (typeof v === "number") return { status: v, json: async () => ({}) };
    return {
      status: 200,
      json: async () => ({
        data: { shop: { plan: { partnerDevelopment: v.dev === true } }, currentAppInstallation: { activeSubscriptions: v.subs } },
      }),
    };
  };
  fn.calls = calls;
  return fn;
}

/** findMany だけ持つ。ほかの関数（update など）を呼んだら落ちる */
function readOnlyPrisma(shops, sessions) {
  const guard = (obj, name) =>
    new Proxy(obj, {
      get(t, k) {
        if (k in t) return t[k];
        if (typeof k === "string") throw new Error(`write-or-unknown call: ${name}.${k}`);
        return undefined;
      },
    });
  return {
    shop: guard({ findMany: async ({ where }) => shops.filter((s) => where.planCode.in.includes(s.planCode) && (!where.shopDomain || s.shopDomain === where.shopDomain)) }, "shop"),
    session: guard({ findMany: async ({ where }) => sessions.filter((s) => where.shop.in.includes(s.shop) && s.isOnline === where.isOnline) }, "session"),
  };
}

describe("classifyShop", () => {
  const read = (subs, extra = {}) => ({ ok: true, source: "admin", subscriptions: subs, ...extra });
  it("契約を読めて Pro が無ければ mismatch", () => {
    assert.equal(classifyShop({ planCode: "pro", reads: [read([])] }).verdict, "mismatch");
    assert.equal(classifyShop({ planCode: "pro", reads: [read([{ name: "Lite", status: "ACTIVE" }])] }).verdict, "mismatch");
    assert.equal(classifyShop({ planCode: "pro", reads: [read([{ name: "Pro", status: "CANCELLED" }])] }).verdict, "mismatch");
  });
  it("有効な Pro があれば ok", () => {
    assert.equal(classifyShop({ planCode: "pro", reads: [read([{ name: "Pro", status: "ACTIVE" }])] }).verdict, "ok");
  });
  it("読めなければ unread（ずれと言わない）", () => {
    const r = classifyShop({ planCode: "pro", reads: [{ ok: false, reason: "token_expired" }] });
    assert.equal(r.verdict, "unread");
    assert.equal(r.reason, "token_expired");
  });
  it("unlimited・CUSTOM_APP_STORE_IDS・開発ストアは別に分ける", () => {
    assert.equal(classifyShop({ planCode: "unlimited", reads: [read([])] }).verdict, "manual");
    assert.equal(classifyShop({ planCode: "pro", customStore: true, reads: [read([])] }).verdict, "exempt");
    assert.equal(classifyShop({ planCode: "pro", reads: [read([], { isDevelopmentStore: true })] }).verdict, "exempt");
  });
});

describe("readAdminSubscriptions", () => {
  it("期限切れのトークンでは聞かない（トークンを新しくしない）", async () => {
    const f = adminFetch({});
    const r = await readAdminSubscriptions({ shopDomain: "a.myshopify.com", session: { accessToken: "x", expires: PAST }, fetchImpl: f, now: () => NOW });
    assert.deepEqual(r, { ok: false, reason: "token_expired" });
    assert.equal(f.calls.length, 0);
  });
  it("セッションが無ければ no_offline_session、401 は理由に残す", async () => {
    assert.equal((await readAdminSubscriptions({ shopDomain: "a.myshopify.com", session: undefined })).reason, "no_offline_session");
    const r = await readAdminSubscriptions({ shopDomain: "a.myshopify.com", session: { accessToken: "x", expires: null }, fetchImpl: adminFetch({ "a.myshopify.com": 401 }), now: () => NOW });
    assert.equal(r.reason, "admin_http_401");
  });
  it("読むだけの query を送る（mutation なし）", async () => {
    const f = adminFetch({ "a.myshopify.com": { subs: [] } });
    await readAdminSubscriptions({ shopDomain: "a.myshopify.com", session: { accessToken: "x", expires: FUTURE }, fetchImpl: f, now: () => NOW });
    const body = JSON.parse(f.calls[0].init.body);
    assert.match(body.query, /^query /);
    assert.doesNotMatch(body.query, /mutation/i);
  });
});

describe("readPartnerConfigForReport", () => {
  it("値がそろえばスイッチがオフでも診断だけは使う・足りなければ null", () => {
    assert.equal(readPartnerConfigForReport({}), null);
    const c = readPartnerConfigForReport({ PARTNER_API_TOKEN: "t", PARTNER_API_ORG_ID: "123", PARTNER_API_APP_ID: "456" });
    assert.equal(c.appGid, "gid://shopify/App/456");
  });
});

describe("buildPlanMismatchReport", () => {
  const shops = [
    { shopDomain: "hole.myshopify.com", shopifyShopGid: "gid://shopify/Shop/1", planCode: "pro", updatedAt: new Date(NOW) },
    { shopDomain: "paid.myshopify.com", shopifyShopGid: "gid://shopify/Shop/2", planCode: "pro", updatedAt: new Date(NOW) },
    { shopDomain: "old.myshopify.com", shopifyShopGid: "gid://shopify/Shop/3", planCode: "pro", updatedAt: new Date(NOW) },
    { shopDomain: "lite.myshopify.com", shopifyShopGid: "gid://shopify/Shop/4", planCode: "lite", updatedAt: new Date(NOW) },
  ];
  const sessions = [
    { shop: "hole.myshopify.com", isOnline: false, accessToken: "a", expires: FUTURE },
    { shop: "paid.myshopify.com", isOnline: false, accessToken: "b", expires: FUTURE },
    { shop: "old.myshopify.com", isOnline: false, accessToken: "c", expires: PAST },
    { shop: "hole.myshopify.com", isOnline: true, accessToken: "online", expires: FUTURE },
  ];
  const fetchImpl = adminFetch({
    "hole.myshopify.com": { subs: [] },
    "paid.myshopify.com": { subs: [{ name: "Pro", status: "ACTIVE" }] },
  });

  it("Pro の店だけを見て、ずれ・OK・読めないに分ける（DB に書かない）", async () => {
    const report = await buildPlanMismatchReport({ prisma: readOnlyPrisma(shops, sessions), env: {}, fetchImpl, now: () => NOW });
    const by = Object.fromEntries(report.rows.map((r) => [r.shopDomain, r.verdict]));
    assert.deepEqual(by, { "hole.myshopify.com": "mismatch", "paid.myshopify.com": "ok", "old.myshopify.com": "unread" });
    assert.deepEqual(report.counts, { mismatch: 1, ok: 1, unread: 1, exempt: 0, manual: 0 });
    // オンラインのトークンは使わない
    assert.ok(fetchImpl.calls.every((c) => c.init.headers["X-Shopify-Access-Token"] !== "online"));
    const text = formatPlanMismatchReport(report);
    assert.match(text, /ずれ（Pro の契約なし）\thole\.myshopify\.com\tpro\tなし/);
    assert.match(text, /何も書きかえていません/);
  });

  it("Partner API で Pro が見えたら Admin を聞かずに OK、無ければ Admin も見る", async () => {
    const partnerFetch = async (url, init) => {
      if (url.startsWith("https://partners.shopify.com/")) {
        const shopId = JSON.parse(init.body).variables.shopId;
        const sub = shopId === "gid://shopify/Shop/3" ? { items: [{ handle: "pro" }], currentBillingCycle: null } : null;
        return { status: 200, text: async () => JSON.stringify({ data: { activeSubscription: sub } }) };
      }
      return fetchImpl(url, init);
    };
    const env = { PARTNER_API_TOKEN: "t", PARTNER_API_ORG_ID: "9", PARTNER_API_APP_ID: "8" };
    const report = await buildPlanMismatchReport({ prisma: readOnlyPrisma(shops, sessions), env, fetchImpl: partnerFetch, now: () => NOW });
    const by = Object.fromEntries(report.rows.map((r) => [r.shopDomain, r]));
    assert.equal(by["old.myshopify.com"].verdict, "ok"); // トークン切れでも Partner で読めた
    assert.equal(by["old.myshopify.com"].source, "partner");
    assert.equal(by["hole.myshopify.com"].verdict, "mismatch");
    assert.equal(by["hole.myshopify.com"].source, "partner+admin");
    assert.equal(report.partnerUsed, true);
  });

  it("--shop で 1 店だけ", async () => {
    const report = await buildPlanMismatchReport({ prisma: readOnlyPrisma(shops, sessions), env: {}, fetchImpl, now: () => NOW, onlyShop: "paid.myshopify.com" });
    assert.equal(report.rows.length, 1);
  });
});

describe("ADMIN_API_VERSION", () => {
  it("アプリ（app/shopify.server.ts）の版と同じ", async () => {
    const { readFileSync } = await import("node:fs");
    const { ADMIN_API_VERSION } = await import("./planMismatch.mjs");
    const src = readFileSync(new URL("../../app/shopify.server.ts", import.meta.url), "utf8");
    const m = src.match(/ApiVersion\.([A-Za-z]+)(\d\d)/);
    const months = { January: "01", April: "04", July: "07", October: "10" };
    assert.ok(m, "apiVersion が見つからない");
    assert.equal(ADMIN_API_VERSION, `20${m[2]}-${months[m[1]]}`);
  });
});
