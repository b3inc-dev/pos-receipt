/**
 * Admin API（app/shopify.server.ts）と Webhook（shopify.app*.toml）の版がそろっていることを確かめる。
 * 版を上げるときに片方だけ変えるのを防ぐ。POS 拡張の api_version は POS UI Extensions の版で、
 * Admin API とは別の系列のため、ここでは「書かれていること」だけを見る。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

const MONTHS: Record<string, string> = {
  January: "01", April: "04", July: "07", October: "10",
};

function adminApiVersion(): string {
  const src = read("app/shopify.server.ts");
  const m = src.match(/apiVersion:\s*ApiVersion\.([A-Za-z]+)(\d{2})\b/);
  assert.ok(m, "app/shopify.server.ts に apiVersion: ApiVersion.XxxYY が無い");
  const month = MONTHS[m[1]];
  assert.ok(month, `四半期の月ではない: ${m[1]}`);
  return `20${m[2]}-${month}`;
}

function webhookApiVersion(tomlPath: string): string {
  const src = read(tomlPath);
  const m = src.match(/\[webhooks\]\s*\napi_version\s*=\s*"(\d{4}-\d{2})"/);
  assert.ok(m, `${tomlPath} の [webhooks] api_version が読めない`);
  return m[1];
}

describe("API の版", () => {
  it("Admin API と自社用 Webhook（shopify.app.toml）が同じ", () => {
    assert.equal(webhookApiVersion("shopify.app.toml"), adminApiVersion());
  });
  it("Admin API と公開用 Webhook（shopify.app.public.toml）が同じ", () => {
    assert.equal(webhookApiVersion("shopify.app.public.toml"), adminApiVersion());
  });
  it("POS 拡張に api_version が書かれている", () => {
    const src = read("extensions/pos-smart-grid/shopify.extension.toml");
    assert.match(src, /^api_version\s*=\s*"\d{4}-\d{2}"/m);
  });
});
