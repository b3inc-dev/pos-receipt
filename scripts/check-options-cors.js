/**
 * OPTIONS /api/* の CORS プリフライト応答を開発環境で確認するだけのスクリプト。
 * ビルドや Shopify の env は不要。server.js と同じミドルウェアで 204 + CORS を返す。
 *
 * 使い方:
 *   node scripts/check-options-cors.js
 * 別ターミナルで:
 *   curl -s -o /dev/null -w "%{http_code}" -X OPTIONS http://localhost:3999/api/settlements/preview -H "Origin: https://admin.shopify.com"
 *   → 204 が返れば OK
 *   curl -v -X OPTIONS http://localhost:3999/api/settlements/preview -H "Origin: https://admin.shopify.com"
 *   → レスポンスヘッダーに Access-Control-Allow-Origin などが出れば OK
 */
import express from "express";

function corsPreflightMiddleware(req, res, next) {
  if (req.method !== "OPTIONS") return next();
  if (!req.path.startsWith("/api")) return next();
  const origin = req.get("Origin") || "*";
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "86400");
  res.status(204).end();
}

const app = express();
app.use(corsPreflightMiddleware);
app.all("*", (req, res) => res.status(404).send("Not found (check only OPTIONS /api/*)"));

const port = Number(process.env.PORT) || 3999;
app.listen(port, () => {
  console.log(`[check-options-cors] http://localhost:${port} — OPTIONS /api/* のみ 204+CORS で応答します`);
  console.log(`確認例: curl -v -X OPTIONS http://localhost:${port}/api/settlements/preview -H "Origin: https://admin.shopify.com"`);
});
