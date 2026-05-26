/**
 * Render 用マイグレーション（常に exit 0）。bash 不要。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = "20260526120000_settlement_operation_lock";

function log(msg) {
  console.log(`[render-migrate] ${msg}`);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

if (!process.env.DATABASE_URL?.trim()) {
  log("DATABASE_URL が未設定のためスキップ（exit 0）");
  process.exit(0);
}

log("resolve --rolled-back (if failed)");
run("npx", ["prisma", "migrate", "resolve", "--rolled-back", LOCK]);

log("migrate deploy (1st)");
if (run("npx", ["prisma", "migrate", "deploy"]) === 0) {
  run("npx", ["prisma", "migrate", "status"]);
  log("done (exit 0)");
  process.exit(0);
}

log("repair SettlementOperationLock");
run("npx", [
  "prisma",
  "db",
  "execute",
  "--file",
  "scripts/ensure-settlement-operation-lock.sql",
  "--schema",
  "prisma/schema.prisma",
]);
run("npx", [
  "prisma",
  "db",
  "execute",
  "--file",
  "scripts/repair-settlement-lock-migration-record.sql",
  "--schema",
  "prisma/schema.prisma",
]);
run("npx", ["prisma", "migrate", "resolve", "--applied", LOCK]);
run("npx", ["prisma", "migrate", "deploy"]);
run("npx", ["prisma", "migrate", "status"]);
log("done (exit 0)");
process.exit(0);
