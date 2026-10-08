#!/usr/bin/env node
/**
 * extensions/common/appUrl.js の APP_MODE が期待値と一致するか検証する。
 * 使用例: node scripts/verify-app-mode.js public
 * deploy:public / deploy:inhouse から set-app-mode の直後に呼ぶ。
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { assertAppModeEquals } from "./lib/deployGuard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appUrlPath = path.join(__dirname, "..", "extensions", "common", "appUrl.js");

const expected = process.argv[2]?.toLowerCase();
if (expected !== "public" && expected !== "inhouse") {
  console.error("Usage: node scripts/verify-app-mode.js <public|inhouse>");
  process.exit(1);
}

const content = readFileSync(appUrlPath, "utf8");
const result = assertAppModeEquals(expected, content);
if (!result.ok) {
  console.error(`[verify-app-mode] ${result.error}`);
  process.exit(1);
}
console.log(`[verify-app-mode] APP_MODE="${result.actual}" OK`);
