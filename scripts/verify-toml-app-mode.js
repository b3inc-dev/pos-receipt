#!/usr/bin/env node
/**
 * CI / ローカル用: toml の application_url と appUrl.js の PROD URL が
 * public / inhouse の対応表どおりか検証する（誤 deploy 防止の静的チェック）。
 *
 * APP_MODE 自体は最終 deploy で書き換わるため、ここでは「どの値か」は問わず、
 * public toml ↔ 公開ホスト、inhouse toml ↔ 自社ホスト、appUrl の両 PROD URL を照合する。
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { validateTomlAppModeMapping } from "./lib/deployGuard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const publicToml = readFileSync(path.join(root, "shopify.app.public.toml"), "utf8");
const inhouseToml = readFileSync(path.join(root, "shopify.app.toml"), "utf8");
const appUrlJs = readFileSync(path.join(root, "extensions", "common", "appUrl.js"), "utf8");

const result = validateTomlAppModeMapping({ publicToml, inhouseToml, appUrlJs });
if (!result.ok) {
  for (const e of result.errors) {
    console.error(`[verify-toml-app-mode] ${e}`);
  }
  process.exit(1);
}
for (const w of result.warnings ?? []) {
  console.warn(`[verify-toml-app-mode] WARN: ${w}`);
}
console.log("[verify-toml-app-mode] public/inhouse toml ↔ PROD URL 対応 OK");
