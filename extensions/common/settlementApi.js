/**
 * POS 精算 API クライアント
 * 要件書 §21.3
 */
import { getAppUrl } from "./appUrl.js";
import { toUserMessage } from "./errorMessage.js";

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
    try {
      const j = await res.json();
      msg = j?.error ?? j?.message ?? msg;
    } catch {}
    const statusSuffix = res.status ? ` (HTTP ${res.status})` : "";
    throw new Error(toUserMessage(msg) + statusSuffix);
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

/** 月ナビゲーション用：利用可能な月一覧取得（DBのみ） */
export async function getAvailableMonths({ locationId } = {}) {
  const params = new URLSearchParams();
  if (locationId) params.set("locationId", locationId);
  return apiFetch(`/api/settlements/available-months?${params.toString()}`);
}

/** 月内日別データ一括取得（DBのみ、当日のみShopify API） */
export async function getMonthRows({ locationId, year, month } = {}) {
  const params = new URLSearchParams();
  if (locationId) params.set("locationId", locationId);
  if (year) params.set("year", String(year));
  if (month) params.set("month", String(month));
  return apiFetch(`/api/settlements/month-rows?${params.toString()}`);
}
