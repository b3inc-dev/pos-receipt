// POS Receipt アプリのベース URL
// 公開用 / 自社用の切り替えは PUBLIC_INHOUSE_APP_DEFINITION.md 参照

const APP_MODE = "public"; // "public" | "inhouse"

const DEV_APP_URL = "http://localhost:3000";
const PROD_APP_URL_PUBLIC = "https://pos-receipt.onrender.com";
const PROD_APP_URL_INHOUSE = "https://pos-receipt-ciara.onrender.com";

const PROD_APP_URL = APP_MODE === "inhouse" ? PROD_APP_URL_INHOUSE : PROD_APP_URL_PUBLIC;

export function getAppUrl(useDev = false) {
  return useDev ? DEV_APP_URL : PROD_APP_URL;
}

export const DEV_URL = DEV_APP_URL;
export const PROD_URL = PROD_APP_URL;
export { APP_MODE };

export default { getAppUrl, DEV_URL, PROD_URL, APP_MODE };
