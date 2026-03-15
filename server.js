/**
 * 本番用カスタムサーバー
 * POS からの CORS プリフライト（OPTIONS）をルーターの前に処理する。
 * react-router-serve では OPTIONS が action に渡らないため、ここで 204 + CORS を返す。
 *
 * 起動: node server.js または npm run start
 */
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import compression from "compression";
import morgan from "morgan";
import { createRequestHandler } from "@react-router/express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildPath = new URL("./build/server/index.js", import.meta.url).href;

/** /api/* への OPTIONS で CORS プリフライトに応答（POST 前にブラウザが送る） */
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

async function main() {
  const build = await import(buildPath);
  const mode = process.env.NODE_ENV || "production";
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST;

  const app = express();
  app.disable("x-powered-by");
  app.use(compression());
  app.use(morgan("tiny"));

  // 静的ファイル（react-router-serve と同様）
  const assetsDir = path.join(__dirname, "build", "client", "assets");
  const publicDir = path.join(__dirname, "build", "client");
  app.use("/assets", express.static(assetsDir, { immutable: true, maxAge: "1y" }));
  app.use(express.static(publicDir));
  app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

  // OPTIONS /api/* を先に処理（CORS プリフライト）
  app.use(corsPreflightMiddleware);

  // それ以外は React Router へ
  app.all("*", createRequestHandler({ build, mode }));

  const server = host ? app.listen(port, host, onListen) : app.listen(port, onListen);
  function onListen() {
    const addr = server?.address();
    const bind = typeof addr === "string" ? addr : addr ? `${addr.address}:${addr.port}` : port;
    console.log(`[server] http://localhost:${port} (listening on ${bind})`);
  }
  ["SIGTERM", "SIGINT"].forEach((sig) => process.once(sig, () => server?.close(console.error)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
