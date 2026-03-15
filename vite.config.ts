import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;

/** 開発時も POS から OPTIONS（CORS プリフライト）が通るようにする。shopify app dev でタイルを開いたまま検証できる。 */
function corsPreflightDevPlugin() {
  return {
    name: "pos-receipt-cors-preflight",
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use((req: { method?: string; url?: string; headers: { origin?: string } }, res: { setHeader: (k: string, v: string) => void; statusCode: number; end: () => void }, next: () => void) => {
        if (req.method === "OPTIONS" && req.url?.startsWith("/api")) {
          const origin = req.headers.origin || "*";
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
          res.setHeader("Access-Control-Max-Age", "86400");
          res.statusCode = 204;
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    port: Number(process.env.PORT || 3000),
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [corsPreflightDevPlugin(), reactRouter(), tsconfigPaths()],
});
