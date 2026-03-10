/**
 * 特殊返金・商品券調整 API クライアント
 * 要件書 21.4 対応
 */

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
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
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
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
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
 * @param {Object} data - sourceOrderId, voucherFaceValue, voucherAppliedAmount, voucherChangeAmount, 他
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
export async function voidSpecialRefund(id) {
  return apiPost(`/api/special-refunds/${id}/void`, {});
}
