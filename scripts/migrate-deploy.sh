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

echo "==> prisma migrate status"
npx prisma migrate status || true

FAILED="$(npx prisma migrate status 2>&1 | grep -c 'failed' || true)"
if [[ "${FAILED}" != "0" ]]; then
  echo "==> 失敗したマイグレーションを rolled-back にマーク（必要な場合のみ）"
  npx prisma migrate resolve --rolled-back 20260526120000_settlement_operation_lock || true
fi

echo "==> prisma migrate deploy"
npx prisma migrate deploy

echo "==> 完了"
npx prisma migrate status
