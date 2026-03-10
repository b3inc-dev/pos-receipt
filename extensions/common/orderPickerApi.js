/**
 * 注文検索・注文詳細をバックエンド API で取得する共通モジュール
 * 要件書 21.2 対応
 */

const session = globalThis?.shopify?.session;

async function getToken() {
  if (!session?.getSessionToken) return null;
  try {
    return await session.getSessionToken();
  } catch {
    return null;
  }
}

async function apiGet(path, params = {}) {
  const { getAppUrl } = await import("./appUrl.js");
  const base = getAppUrl();
  const url = new URL(path, base);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });
  const token = await getToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), { method: "GET", headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

/**
 * GET /api/orders/search
 * @param {Object} opts - q, locationId, dateFrom, dateTo, cursor, limit
 * @returns {{ items: Array, nextCursor: string|null }}
 */
export async function searchOrders(opts = {}) {
  const { q, locationId, dateFrom, dateTo, cursor, limit } = opts;
  const data = await apiGet("/api/orders/search", {
    q: q ?? undefined,
    locationId: locationId ?? undefined,
    dateFrom: dateFrom ?? undefined,
    dateTo: dateTo ?? undefined,
    cursor: cursor ?? undefined,
    limit: limit ?? 20,
  });
  return { items: data.items ?? [], nextCursor: data.nextCursor ?? null };
}

/**
 * GET /api/orders/:orderId
 * @param {string} orderId - 数値または GID
 * @returns {Promise<Object>} 注文詳細
 */
export async function getOrder(orderId) {
  if (!orderId) throw new Error("orderId required");
  const id = String(orderId).replace(/^gid:\/\/shopify\/Order\//, "");
  return apiGet(`/api/orders/${id}`);
}
