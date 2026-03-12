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
    body {
      margin: 0;
      padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom));
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", sans-serif;
      background: #f4f5f7;
      color: #202223;
      min-height: 100vh;
    }
    .container { max-width: 360px; margin: 0 auto; }
    h1 {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 20px;
      text-align: center;
      color: #202223;
      letter-spacing: 0.02em;
    }
    .loading {
      text-align: center;
      padding: 56px 20px;
      color: #6d7175;
      font-size: 15px;
    }
    .loading::before {
      content: "";
      display: block;
      width: 32px;
      height: 32px;
      margin: 0 auto 16px;
      border: 3px solid #e1e3e5;
      border-top-color: #5c5f62;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error {
      background: #fff4e5;
      border: 1px solid #e0b252;
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 16px;
      color: #202223;
      font-size: 14px;
      line-height: 1.5;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      padding: 28px 24px;
      margin-bottom: 20px;
    }
    .barcode-wrap {
      display: flex;
      justify-content: center;
      align-items: center;
      margin: 20px 0;
      padding: 20px 12px;
      background: #fff;
      border-radius: 12px;
      border: 1px solid #e1e3e5;
    }
    #barcode-wrap { display: block; max-width: 100%; height: auto; }
    .member-id-label {
      font-size: 12px;
      color: #6d7175;
      text-align: center;
      margin: 0 0 6px;
      letter-spacing: 0.05em;
    }
    .member-id {
      font-size: 20px;
      font-weight: 600;
      text-align: center;
      margin: 0 0 20px;
      letter-spacing: 0.12em;
      color: #202223;
    }
    .hint {
      font-size: 13px;
      color: #6d7175;
      text-align: center;
      margin: 0;
      line-height: 1.6;
    }
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
    var safeId = String(memberId).replace(/</g, '&lt;');
    root.innerHTML = '<div class="card"><div class="barcode-wrap"><svg id="barcode-wrap"></svg></div><p class="member-id-label">会員番号</p><div class="member-id">' + safeId + '</div><p class="hint">スタッフにこの画面を提示してください。</p></div>';
    var wrap = document.getElementById('barcode-wrap');
    try {
      JsBarcode(wrap, String(memberId).trim(), { format: 'CODE128', width: 2, height: 80, displayValue: false });
    } catch (e) {
      root.querySelector('.card').innerHTML = '<p class="error">バーコードの表示に失敗しました</p><div class="member-id">' + String(memberId).replace(/</g, '&lt;') + '</div>';
    }
  }

  var messages = {
    LIFF_INIT_FAILED: 'LIFFの初期化に失敗しました（LIFF ID・Endpoint URLを確認）',
    ID_TOKEN_FAILED: 'IDトークンの取得に失敗しました',
    LINE_AUTH_FAILED: 'LINE認証に失敗しました',
    ID_TOKEN_EXPIRED: 'トークンの有効期限が切れました。ページを再読み込みするか、LINEアプリから開き直してください。',
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
