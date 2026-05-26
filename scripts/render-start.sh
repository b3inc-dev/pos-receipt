#!/usr/bin/env bash
# Render 本番起動: マイグレーション（失敗しても続行）→ カスタムサーバー
cd "$(dirname "$0")/.."

echo "[render-start] running migrations (non-blocking)"
bash scripts/render-migrate.sh

echo "[render-start] starting node server.js"
exec node server.js
