#!/usr/bin/env node
/**
 * 本番 PostgreSQL にマイグレーションを適用する。
 *
 * 事前準備（どちらか）:
 *   A) pos-receipt/.env の DATABASE_URL= に Render の Internal Database URL を入れる
 *   B) cp .env.migrate.example .env.migrate して DATABASE_URL を入れる（.env より優先されないが空なら使う）
 *
 * 実行: npm run db:migrate:production
 */
import "./load-env-files.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    [
      "ERROR: DATABASE_URL が空です。",
      "",
      "Render → Postgres → Connect → Internal Database URL をコピーし、",
      "  pos-receipt/.env の DATABASE_URL= に貼る",
      "または",
      "  cp .env.migrate.example .env.migrate して DATABASE_URL を入れる",
      "",
      "設定後、もう一度: npm run db:migrate:production",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("==> prisma generate");
const gen = spawnSync("npx", ["prisma", "generate"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (gen.status !== 0) process.exit(gen.status ?? 1);

console.log("==> render-migrate (deploy + 復旧)");
const mig = spawnSync("node", ["scripts/render-migrate.mjs"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
process.exit(mig.status ?? 1);
