#!/usr/bin/env bash
# Render 本番起動用: マイグレーション失敗の自動復旧 → サーバー起動
set -euo pipefail
cd "$(dirname "$0")/.."

LOCK_MIGRATION="20260526120000_settlement_operation_lock"

log() {
  echo "[render-start] $*"
}

run_migrate_deploy() {
  npx prisma migrate deploy
}

recover_settlement_lock_migration() {
  log "failed migration を rolled-back にマーク（存在すれば）"
  npx prisma migrate resolve --rolled-back "$LOCK_MIGRATION" 2>/dev/null || true

  log "SettlementOperationLock を冪等 SQL で確保"
  npx prisma db execute \
    --file scripts/ensure-settlement-operation-lock.sql \
    --schema prisma/schema.prisma

  log "マイグレーションを applied にマーク"
  npx prisma migrate resolve --applied "$LOCK_MIGRATION"
}

log "prisma migrate deploy を実行"
if run_migrate_deploy; then
  log "migrate deploy 成功"
else
  log "migrate deploy 失敗 → 復旧を試行"
  recover_settlement_lock_migration
  run_migrate_deploy
fi

log "node server.js を起動"
exec node server.js
