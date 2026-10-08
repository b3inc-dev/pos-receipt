/**
 * GET /env-check — 401 デバッグ用（認証不要）
 *
 * サーバーが読み込んでいる SHOPIFY_API_KEY / SHOPIFY_API_SECRET の状態を確認できます。
 * 値は返さず、先頭数文字・長さ・未設定かどうかのみ返します。
 *
 * 本番で 401 の原因を切り分けたあとは、このルートを削除するか無効化してください。
 */
import type { LoaderFunctionArgs } from "react-router";

const EXPECTED_API_KEY_PREFIX = "ec537415"; // POS Receipt - Ciara の Client ID の先頭

export async function loader({ request }: LoaderFunctionArgs) {
  const key = process.env.SHOPIFY_API_KEY?.trim() ?? "";
  const secret = process.env.SHOPIFY_API_SECRET?.trim() ?? "";
  const appUrl = process.env.SHOPIFY_APP_URL?.trim() ?? "";
  const distribution = (process.env.APP_DISTRIBUTION ?? "").trim();
  const distributionNorm = distribution.toLowerCase();
  const distributionOk =
    distributionNorm === "" || distributionNorm === "public" || distributionNorm === "inhouse";

  const body = {
    message: "401 / 公開自社取り違えデバッグ用。本番では不要になったらこのルートを削除してください。",
    SHOPIFY_API_KEY: {
      set: key.length > 0,
      length: key.length,
      prefix: key.length >= 8 ? key.slice(0, 8) : "(不足)",
      expectedPrefix: EXPECTED_API_KEY_PREFIX,
      match: key.slice(0, 8) === EXPECTED_API_KEY_PREFIX,
    },
    SHOPIFY_API_SECRET: {
      set: secret.length > 0,
      length: secret.length,
      note: "値は表示しません。shpss_ で始まる 38 文字は正しい形式（shpss_ + 32 文字）。",
    },
    SHOPIFY_APP_URL: {
      set: appUrl.length > 0,
      prefix: appUrl.slice(0, 40) + (appUrl.length > 40 ? "…" : ""),
    },
    APP_DISTRIBUTION: {
      set: distribution.length > 0,
      value: distribution.length > 0 ? distribution : "(unset → public扱い)",
      ok: distributionOk,
      note: "inhouse / public / 未設定のみ。typo は server.js 起動ガードで拒否。",
    },
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
