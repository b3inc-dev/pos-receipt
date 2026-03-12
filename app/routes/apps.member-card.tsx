/**
 * App Proxy 経由で公開される LIFF 会員証ページ（GET のみ）。
 * カスタムアプリ（APP_DISTRIBUTION=inhouse）でのみ有効。公開アプリでは 404 を返す。
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { isInhouseMode } from "../utils/planFeatures.server";

const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";
const JSBARCODE_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.3/JsBarcode.all.min.js";

function buildHtml(liffId: string, apiBase: string, shop: string): string {
  const escapedShop = shop
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ");
  const escapedApiBase = apiBase
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <title>会員証</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fff; color: #202223; min-height: 100vh; }
    .container { max-width: 360px; margin: 0 auto; }
    h1 { font-size: 20px; font-weight: 700; margin: 0 0 24px; text-align: center; }
    .loading { text-align: center; padding: 48px 16px; color: #6d7175; font-size: 14px; }
    .error { background: #fff4e5; border: 1px solid #e0b252; border-radius: 8px; padding: 16px; margin-bottom: 16px; color: #202223; font-size: 14px; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 24px; margin-bottom: 16px; }
    #barcode-wrap { text-align: center; margin: 16px 0; }
    #barcode-wrap svg { max-width: 100%; height: auto; }
    .member-id { font-size: 18px; font-weight: 600; text-align: center; margin: 16px 0; letter-spacing: 0.05em; }
    .hint { font-size: 13px; color: #6d7175; text-align: center; margin-top: 24px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <h1>会員証</h1>
    <div id="root">
      <div class="loading">読み込み中…</div>
    </div>
  </div>
  <script src="${LIFF_SDK_URL}"></script>
  <script src="${JSBARCODE_CDN}"></script>
  <script>
(function() {
  var LIFF_ID = '${liffId}';
  var API_BASE = '${escapedApiBase}';
  var SHOP = '${escapedShop}';

  var root = document.getElementById('root');

  var isDebug = typeof location !== 'undefined' && location.search.indexOf('debug=1') !== -1;

  function esc(s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function showError(msg, detail) {
    var html = '<div class="error">' + esc(msg) + '</div>';
    if (detail && isDebug) {
      html += '<div class="error" style="margin-top:8px;font-size:12px;word-break:break-all;">' + esc(detail) + '</div>';
    }
    root.innerHTML = html;
  }

  function showMember(memberId) {
    root.innerHTML = '<div class="card"><div id="barcode-wrap"></div><div class="member-id">' + String(memberId).replace(/</g, '&lt;') + '</div><div class="hint">スタッフにこの画面を提示してください。</div></div>';
    var wrap = document.getElementById('barcode-wrap');
    try {
      JsBarcode(wrap, memberId, { format: 'CODE128', width: 2, height: 80, displayValue: false });
    } catch (e) {
      wrap.innerHTML = '<p class="error">バーコードの表示に失敗しました</p>';
    }
  }

  var messages = {
    LIFF_INIT_FAILED: 'LIFFの初期化に失敗しました（LIFF ID・Endpoint URLを確認）',
    ID_TOKEN_FAILED: 'IDトークンの取得に失敗しました',
    LINE_AUTH_FAILED: 'LINE認証に失敗しました',
    CUSTOMER_NOT_LINKED: 'LINE連携済み会員が見つかりません',
    MEMBER_ID_NOT_SET: '会員番号が設定されていません',
    SYSTEM_ERROR: 'システムエラーが発生しました'
  };

  function run() {
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    var tokenPromise = liff.getIDToken();
    if (tokenPromise && typeof tokenPromise.then === 'function') {
      tokenPromise.then(sendTokenToApi).catch(function() { showError(messages.ID_TOKEN_FAILED); });
    } else {
      sendTokenToApi(tokenPromise);
    }
  }

  function sendTokenToApi(idToken) {
    if (!idToken) {
      showError(messages.ID_TOKEN_FAILED);
      return;
    }
    fetch(API_BASE + '/api/member-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: idToken, shop: SHOP })
    }).then(function(res) { return res.json(); }).then(function(data) {
      if (data.ok && data.memberId) {
        showMember(data.memberId);
      } else {
        showError(messages[data.message] || messages.SYSTEM_ERROR);
      }
    }).catch(function() {
      showError(messages.SYSTEM_ERROR);
    });
  }

  liff.init({ liffId: LIFF_ID }).then(run).catch(function(err) {
    var detail = isDebug && err && err.message
      ? 'ページURL: ' + location.href + ' / LIFF ID: ' + LIFF_ID + ' / エラー: ' + err.message
      : (isDebug ? 'ページURL: ' + location.href + ' / LIFF ID: ' + LIFF_ID : null);
    showError(messages.LIFF_INIT_FAILED, detail);
  });
})();
  </script>
</body>
</html>`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isInhouseMode()) {
    return new Response(
      "<!DOCTYPE html><html><head><meta charset='utf-8'/><title>ご利用できません</title></head><body><p>この機能はカスタムアプリでのみご利用いただけます。</p></body></html>",
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const liffId = process.env.LIFF_ID?.trim() ?? "";
  const apiBase = (process.env.SHOPIFY_APP_URL?.trim() ?? "").replace(/\/$/, "");

  if (!liffId || !apiBase) {
    return new Response(
      "<!DOCTYPE html><html><body><p>設定エラー: LIFF_ID または SHOPIFY_APP_URL が未設定です。</p></body></html>",
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const html = buildHtml(liffId, apiBase, shop);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
