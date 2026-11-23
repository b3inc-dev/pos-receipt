/**
 * 特殊返金・商品券調整 API クライアント
 * 要件書 21.4 対応
 */
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

async function buildHeaders() {
  const token = await getToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function getBaseUrl() {
  const { getAppUrl } = await import("./appUrl.js");
  return getAppUrl();
}

async function apiGet(path, params = {}) {
  const base = await getBaseUrl();
  const url = new URL(path, base);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: await buildHeaders(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = toUserMessage(json.error || `HTTP ${res.status}`);
    throw new Error(msg + (res.status ? ` (HTTP ${res.status})` : ""));
  }
  return json;
}

async function apiPost(path, body) {
  const base = await getBaseUrl();
  const url = new URL(path, base);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: await buildHeaders(),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = toUserMessage(json.error || `HTTP ${res.status}`);
    throw new Error(msg + (res.status ? ` (HTTP ${res.status})` : ""));
  }
  return json;
}

/**
 * GET /api/special-refunds?sourceOrderId=...
 * @param {string} sourceOrderId
 * @returns {Promise<{ items: Array }>}
 */
export async function listSpecialRefunds(sourceOrderId) {
  return apiGet("/api/special-refunds", { sourceOrderId });
}

/**
 * POST /api/special-refunds
 * @param {Object} data - sourceOrderId, eventType, amount, 他
 * @returns {Promise<{ ok: boolean, event: Object }>}
 */
export async function createSpecialRefund(data) {
  return apiPost("/api/special-refunds", data);
}

/**
 * POST /api/voucher-adjustments
 * @param {Object} data - sourceOrderId, voucherFaceValue（必須）, voucherAppliedAmount（任意。無ければ注文の取引から）, 他
 * @returns {Promise<{ ok: boolean, event: Object }>}
 */
export async function createVoucherAdjustment(data) {
  return apiPost("/api/voucher-adjustments", data);
}

/**
 * POST /api/special-refunds/:id/void
 * @param {string} id
 * @returns {Promise<{ ok: boolean, event: Object }>}
 */
export async function voidSpecialRefund(id, body = {}) {
  return apiPost(`/api/special-refunds/${id}/void`, body);
}

/**
 * POST /api/special-refunds/:id/edit
 * 「変更」: 前の登録を無効にし、直した内容の登録を足す（Shopify の返金はしない）。
 * @param {string} id
 * @param {{ reason: string, dateMode?: "original" | "today", amount?: number, actualRefundMethod?: string,
 *   originalPaymentMethod?: string, adjustKind?: string, voucherFaceValue?: number, note?: string }} body
 */
export async function editSpecialRefund(id, body) {
  return apiPost(`/api/special-refunds/${encodeURIComponent(id)}/edit`, body);
}

/**
 * GET /api/voucher-adjustments?sourceOrderId=...
 * その注文で商品券で払った額（注文の取引から）。読めなければ voucherAppliedAmount は null。
 * @param {string} sourceOrderId
 * @returns {Promise<{ ok: boolean, voucherAppliedAmount: number | null, appliedFromOrder: boolean }>}
 */
export async function getVoucherApplied(sourceOrderId) {
  return apiGet("/api/voucher-adjustments", { sourceOrderId });
}

/**
 * POST /api/special-refunds/:id/recheck
 * 前からある pending の登録を、Shopify の返金を読み直して決める（返金は実行しない）。
 * @param {string} id
 * @param {{ resolution?: "link" | "no_refund", refundId?: string }} [body]
 */
export async function recheckLegacySpecialRefund(id, body = {}) {
  return apiPost(`/api/special-refunds/${encodeURIComponent(id)}/recheck`, body);
}
