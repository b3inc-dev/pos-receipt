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
const CARD_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0627/8669/9510/files/ciara-logo-white.png";

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
    .plastic-card {
      width: 100%;
      max-width: 340px;
      margin: 0 auto 16px;
      aspect-ratio: 1.586;
      background: #e3c8aa;
      border-radius: 16px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.12);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .plastic-card-top {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px 24px;
      min-height: 0;
    }
    .plastic-card-logo {
      max-width: 120px;
      max-height: 48px;
      width: auto;
      height: auto;
      object-fit: contain;
    }
    .plastic-card-bottom {
      padding: 12px 16px 0;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-end;
    }
    .plastic-card .barcode-id-block {
      background: #fff;
      border-radius: 0;
      padding: 10px 10px 8px;
      margin: 0 0 0;
    }
    .plastic-card .barcode-id-block .barcode-wrap {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      margin: 0 0 6px;
    }
    .plastic-card .barcode-id-block .barcode-wrap svg { width: 100%; height: 56px; max-width: 100%; }
    .plastic-card .barcode-id-block .member-id-on-card {
      text-align: center;
    }
    .plastic-card .card-bottom-spacer {
      height: 14px;
      background: #e3c8aa;
      margin: 0 -1px 0 0;
    }
    .plastic-card .member-id-on-card {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.08em;
      color: #202223;
    }
    .hint-below-card {
      font-size: 13px;
      color: #6d7175;
      text-align: center;
      margin: 0 0 20px;
      line-height: 1.6;
    }
    .section-bordered {
      border-top: 1px solid #e1e3e5;
      border-bottom: 1px solid #e1e3e5;
      padding: 14px 0;
      margin-bottom: 16px;
      font-size: 14px;
      color: #202223;
      text-align: center;
    }
    .section-bordered .label { color: #6d7175; }
    .rank-row { margin-bottom: 12px; font-size: 14px; text-align: center; }
    .rank-row .label { color: #6d7175; }
    .points-row { margin-top: 4px; text-align: center; }
    .points-value {
      font-size: 28px;
      font-weight: 700;
      color: #202223;
      letter-spacing: 0.02em;
    }
    .points-unit { font-size: 14px; color: #6d7175; margin-left: 4px; }
  </style>
</head>
<body>
  <div class="container">
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

  function esc(s) {
    if (s == null || s === '') return '';
    return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function showError(msg, detail) {
    var html = '<div class="error">' + esc(msg) + '</div>';
    if (detail && isDebug) {
      html += '<div class="error" style="margin-top:8px;font-size:12px;word-break:break-all;">' + esc(detail) + '</div>';
    }
    root.innerHTML = html;
  }

  function formatPoints(val) {
    if (val == null || val === '') return '';
    var str = String(val).replace(/[^0-9-]/g, '');
    var n = parseInt(str, 10);
    if (isNaN(n)) return String(val);
    return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  }
  function showMember(data) {
    var memberId = data.memberId || '';
    var rankName = data.rankName != null ? data.rankName : '';
    var pointsApproved = data.pointsApproved != null ? data.pointsApproved : '';
    var safeId = esc(memberId);
    var safeRank = esc(rankName);
    var pointsDisplay = formatPoints(pointsApproved);
    var logoUrl = '${CARD_LOGO_URL}';
    var html = '<div class="plastic-card">' +
      '<div class="plastic-card-top"><img class="plastic-card-logo" src="' + logoUrl + '" alt="" /></div>' +
      '<div class="plastic-card-bottom">' +
        '<div class="barcode-id-block">' +
          '<div class="barcode-wrap"><svg id="barcode-wrap"></svg></div>' +
          '<div class="member-id-on-card">' + safeId + '</div>' +
        '</div>' +
        '<div class="card-bottom-spacer"></div>' +
      '</div></div>' +
      '<p class="hint-below-card">お会計の際にこの画面のバーコードを提示してください。</p>' +
      '<div class="section-bordered">会員ID：' + safeId + '</div>' +
      '<div class="rank-row"><span class="label">現在のランク：</span>' + (safeRank || '—') + '</div>' +
      '<div class="points-row"><span class="points-value">' + (pointsDisplay ? esc(pointsDisplay) : '0') + '</span><span class="points-unit">ポイント</span></div>';
    root.innerHTML = html;
    var wrap = document.getElementById('barcode-wrap');
    if (wrap) {
      try {
        JsBarcode(wrap, String(memberId).trim(), { format: 'CODE128', width: 2, height: 56, displayValue: false });
      } catch (e) {
        root.querySelector('.plastic-card-bottom').innerHTML = '<div class="barcode-id-block"><p class="error">バーコードの表示に失敗しました</p><div class="member-id-on-card">' + safeId + '</div></div><div class="card-bottom-spacer"></div>';
      }
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
        showMember({ memberId: data.memberId, rankName: data.rankName, pointsApproved: data.pointsApproved });
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
