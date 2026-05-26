#!/usr/bin/env bash
# 本番・ステージング DB に prisma migrate deploy を適用する。
# 使い方:
#   1. Render → Postgres → Connect → Internal Database URL をコピー
#   2. export DATABASE_URL='postgresql://...'  または .env に貼る
#   3. ./scripts/migrate-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -f .env ]]; then
    # shellcheck disable=SC1091
    set -a
    source .env
    set +a
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL が空です。"
  echo "Render の Postgres → Connect → Internal Database URL を .env の DATABASE_URL= に設定してください。"
  exit 1
fi

echo "==> prisma generate"
npx prisma generate

LOCK_MIGRATION="20260526120000_settlement_operation_lock"

echo "==> prisma migrate status"
npx prisma migrate status || true

echo "==> prisma migrate deploy"
if npx prisma migrate deploy; then
  echo "==> migrate deploy 成功"
else
  echo "==> migrate deploy 失敗 → 復旧を試行"
  npx prisma migrate resolve --rolled-back "$LOCK_MIGRATION" 2>/dev/null || true
  npx prisma db execute \
    --file scripts/ensure-settlement-operation-lock.sql \
    --schema prisma/schema.prisma
  npx prisma db execute \
    --file scripts/repair-settlement-lock-migration-record.sql \
    --schema prisma/schema.prisma
  npx prisma migrate resolve --applied "$LOCK_MIGRATION"
  npx prisma migrate deploy
fi

echo "==> 完了"
npx prisma migrate status
