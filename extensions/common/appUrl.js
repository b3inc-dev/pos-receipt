// POS Receipt アプリのベース URL
// 公開用 / 自社用の切り替えは PUBLIC_INHOUSE_APP_DEFINITION.md 参照

const APP_MODE = "public"; // "public" | "inhouse"

const DEV_APP_URL = "http://localhost:3000";
const PROD_APP_URL_PUBLIC = "https://pos-receipt.onrender.com";
const PROD_APP_URL_INHOUSE = "https://pos-receipt-ciara.onrender.com";

const PROD_APP_URL = APP_MODE === "inhouse" ? PROD_APP_URL_INHOUSE : PROD_APP_URL_PUBLIC;

/** 現在の実行環境が dev 系（トンネル・localhost）かどうか */
function isDevOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  const o = origin.toLowerCase();
  return (
    o.startsWith("http://localhost") ||
    o.startsWith("https://localhost") ||
    o.includes("127.0.0.1") ||
    o.includes("ngrok") ||
    o.includes("loca.lt") ||
    o.includes("cloudflaretunnel")
  );
}

/**
 * バックエンドのベース URL を返す。
 * shopify app dev で拡張がトンネルから読み込まれた場合は、そのオリジンに API を飛ばす（Load failed 防止）。
 */
export function getAppUrl(useDev = false) {
  if (typeof globalThis !== "undefined" && globalThis.window?.location?.origin) {
    const origin = globalThis.window.location.origin;
    if (isDevOrigin(origin)) return origin;
  }
  return useDev ? DEV_APP_URL : PROD_APP_URL;
}

export const DEV_URL = DEV_APP_URL;
export const PROD_URL = PROD_APP_URL;
export { APP_MODE };

export default { getAppUrl, DEV_URL, PROD_URL, APP_MODE };
