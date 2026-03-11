/**
 * POS 領収書 API クライアント
 * 要件書 §21.5
 */
import { getAppUrl } from "./appUrl.js";

const BASE = getAppUrl();

async function apiFetch(path, options = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error ?? j?.message ?? msg; } catch {}
    throw new Error(msg);
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
 * 領収書発行
 * idempotencyKey を自動生成して送信することで、ネットワーク再試行時の重複発行を防ぐ。
 * 再発行時（isReissue=true）は毎回新規キーを生成する。
 */
export async function issueReceipt({ orderId, recipientName, proviso, isReissue = false }) {
  const idempotencyKey = crypto.randomUUID();
  return apiFetch("/api/receipts/issue", {
    method: "POST",
    body: JSON.stringify({ orderId, recipientName, proviso, isReissue, idempotencyKey }),
  });
}

/** 領収書履歴 */
export async function getReceiptHistory({ orderId, dateFrom, dateTo, limit = 10 } = {}) {
  const params = new URLSearchParams();
  if (orderId) params.set("orderId", orderId);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  params.set("limit", String(limit));
  return apiFetch(`/api/receipts/history?${params.toString()}`);
}
