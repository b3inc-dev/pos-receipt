// POS Receipt アプリのベース URL
// 公開用 / 自社用の切り替えは PUBLIC_INHOUSE_APP_DEFINITION.md 参照

const APP_MODE = "inhouse"; // "public" | "inhouse"

const DEV_APP_URL = "http://localhost:3000";
const PROD_APP_URL_PUBLIC = "https://pos-receipt.onrender.com";
const PROD_APP_URL_INHOUSE = "https://pos-receipt-ciara.onrender.com";

const PROD_APP_URL = APP_MODE === "inhouse" ? PROD_APP_URL_INHOUSE : PROD_APP_URL_PUBLIC;

const STORAGE_KEY_API_BASE = "pos-receipt-api-base";

/** 開発時のみ：API 接続先を上書き（localStorage）。空で解除。 */
export function setApiBaseOverride(url) {
  if (typeof globalThis === "undefined" || !globalThis.localStorage) return;
  const v = typeof url === "string" ? url.trim().replace(/\/$/, "") : "";
  if (v) globalThis.localStorage.setItem(STORAGE_KEY_API_BASE, v);
  else globalThis.localStorage.removeItem(STORAGE_KEY_API_BASE);
}

/** 開発時のみ：上書きされている API 接続先。未設定なら null。 */
export function getApiBaseOverride() {
  if (typeof globalThis === "undefined" || !globalThis.localStorage) return null;
  const v = globalThis.localStorage.getItem(STORAGE_KEY_API_BASE);
  return v && v.trim() ? v.trim().replace(/\/$/, "") : null;
}

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
 * 開発用オーバーライドが設定されていればそれを返す。
 * shopify app dev で拡張がトンネルから読み込まれた場合は、そのオリジンに API を飛ばす。
 */
export function getAppUrl(useDev = false) {
  const override = getApiBaseOverride();
  if (override) return override;
  if (typeof globalThis !== "undefined" && globalThis.window?.location?.origin) {
    const origin = globalThis.window.location.origin;
    if (isDevOrigin(origin)) return origin;
  }
  return useDev ? DEV_APP_URL : PROD_APP_URL;
}

export const DEV_URL = DEV_APP_URL;
export const PROD_URL = PROD_APP_URL;
export { APP_MODE };

/** 接続先URLが開発用（トンネル・localhost）かどうか。切り分けメッセージの出し分けに使う */
export function isDevApiUrl(url) {
  if (!url || typeof url !== "string") return false;
  const o = url.toLowerCase();
  return (
    o.startsWith("http://localhost") ||
    o.startsWith("https://localhost") ||
    o.includes("127.0.0.1") ||
    o.includes("ngrok") ||
    o.includes("loca.lt") ||
    o.includes("cloudflaretunnel")
  );
}

export default { getAppUrl, setApiBaseOverride, getApiBaseOverride, isDevApiUrl, DEV_URL, PROD_URL, APP_MODE };
