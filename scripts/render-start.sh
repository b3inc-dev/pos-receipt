#!/usr/bin/env bash
# 互換用（推奨は npm run start = node server.js のみ）
cd "$(dirname "$0")/.."
node scripts/render-migrate.mjs
exec node server.js
