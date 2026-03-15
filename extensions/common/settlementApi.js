/**
 * POS 精算 API クライアント
 * 要件書 §21.3
 */
import { getAppUrl } from "./appUrl.js";

const BASE = getAppUrl();

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
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: await buildHeaders(options.headers ?? {}),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j?.error ?? j?.message ?? msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** ロケーション一覧取得 */
export async function getLocations() {
  return apiFetch("/api/locations");
}

/** 精算プレビュー */
export async function previewSettlement({ locationId, locationName, targetDate }) {
  return apiFetch("/api/settlements/preview", {
    method: "POST",
    body: JSON.stringify({ locationId, locationName, targetDate }),
  });
}

/** 精算実行・保存 */
export async function createSettlement({ locationId, locationName, targetDate, printMode, isInspection = false }) {
  return apiFetch("/api/settlements/create", {
    method: "POST",
    body: JSON.stringify({ locationId, locationName, targetDate, printMode, isInspection }),
  });
}

/** 再集計 */
export async function recalculateSettlement({ settlementId, locationId, locationName, targetDate }) {
  return apiFetch("/api/settlements/recalculate", {
    method: "POST",
    body: JSON.stringify({ settlementId, locationId, locationName, targetDate }),
  });
}

/** 精算履歴一覧 */
export async function getSettlementHistory({ locationId, targetDate, limit = 10 } = {}) {
  const params = new URLSearchParams();
  if (locationId) params.set("locationId", locationId);
  if (targetDate) params.set("targetDate", targetDate);
  params.set("limit", String(limit));
  return apiFetch(`/api/settlements/print?${params.toString()}`);
}

/** 印字済みマーク */
export async function markSettlementPrinted(settlementId) {
  return apiFetch("/api/settlements/print", {
    method: "POST",
    body: JSON.stringify({ settlementId }),
  });
}
