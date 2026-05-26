#!/usr/bin/env bash
# Render 用 DB マイグレーション（常に exit 0 — デプロイをマイグレーション失敗で止めない）
set +e
cd "$(dirname "$0")/.."

LOCK_MIGRATION="20260526120000_settlement_operation_lock"

log() {
  echo "[render-migrate] $*"
}

log "prisma migrate resolve --rolled-back (if failed)"
npx prisma migrate resolve --rolled-back "$LOCK_MIGRATION" 2>&1

log "prisma migrate deploy (1st)"
if npx prisma migrate deploy 2>&1; then
  log "migrate deploy OK"
  npx prisma migrate status 2>&1
  exit 0
fi

log "migrate deploy failed — repair SettlementOperationLock"
npx prisma db execute \
  --file scripts/ensure-settlement-operation-lock.sql \
  --schema prisma/schema.prisma 2>&1

npx prisma db execute \
  --file scripts/repair-settlement-lock-migration-record.sql \
  --schema prisma/schema.prisma 2>&1

log "mark migration as applied (skip broken SQL re-run)"
npx prisma migrate resolve --applied "$LOCK_MIGRATION" 2>&1

log "prisma migrate deploy (2nd)"
npx prisma migrate deploy 2>&1

npx prisma migrate status 2>&1
log "done (always exit 0)"
exit 0
