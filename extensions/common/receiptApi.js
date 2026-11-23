/**
 * POS 領収書 API クライアント
 * 要件書 §21.5
 */
import { getAppUrl } from "./appUrl.js";
import { toUserMessage, withStatus } from "./errorMessage.js";

async function getToken() {
  const session = globalThis?.shopify?.session;
  if (!session?.getSessionToken) return null;
  try {
    return await session.getSessionToken();
  } catch {
    return null;
  }
}

async function buildHeaders(extra = {}) {
  const token = await getToken();
  const headers = { "Content-Type": "application/json", ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function apiFetch(path, options = {}) {
  const url = `${getAppUrl()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: await buildHeaders(options.headers ?? {}),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error ?? j?.message ?? msg; } catch {}
    // 画面の文に「(HTTP 500)」は出さない（店の人には関係ない）。番号は err.status に残す
    throw withStatus(new Error(toUserMessage(msg)), res.status);
  }
  return res.json();
}

/** 領収書テンプレート取得 */
export async function getReceiptTemplate() {
  return apiFetch("/api/settings/receipt-template");
}

/** 領収書プレビュー */
export async function previewReceipt({ orderId, recipientName, proviso }) {
  return apiFetch("/api/receipts/preview", {
    method: "POST",
    body: JSON.stringify({ orderId, recipientName, proviso }),
  });
}

/**
 * 領収書を発行した人のスタッフ ID（POS でピン留め中のスタッフ。無ければ POS にログイン中のユーザー）。
 * 名前はサーバーが「スタッフ名」の登録から引く。取れなければ undefined（発行は止めない）。
 */
export function currentStaffMemberId() {
  try {
    const s = globalThis?.shopify?.session?.currentSession;
    const id = s?.staffMemberId ?? s?.userId;
    return id === null || id === undefined || id === 0 ? undefined : id;
  } catch {
    return undefined;
  }
}

/**
 * 領収書発行
 * idempotencyKey を自動生成して送信することで、ネットワーク再試行時の重複発行を防ぐ。
 * 再発行時（isReissue=true）は毎回新規キーを生成する。
 */
export async function issueReceipt({ orderId, recipientName, proviso, isReissue = false }) {
  const idempotencyKey = crypto.randomUUID();
  const staffMemberId = currentStaffMemberId();
  return apiFetch("/api/receipts/issue", {
    method: "POST",
    body: JSON.stringify({ orderId, recipientName, proviso, isReissue, idempotencyKey, staffMemberId }),
  });
}

/** 領収書履歴 */
export async function getReceiptHistory({ orderId, dateFrom, dateTo, limit = 10, locationId, q } = {}) {
  const params = new URLSearchParams();
  if (orderId) params.set("orderId", orderId);
  if (locationId) params.set("locationId", String(locationId));
  if (q) params.set("q", q);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  params.set("limit", String(limit));
  return apiFetch(`/api/receipts/history?${params.toString()}`);
}
