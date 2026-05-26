/**
 * POS 向け支払方法マスタ API
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

/**
 * GET /api/payment-methods/selectable?sync=1
 * @param {{ sync?: boolean }} [opts]
 * @returns {Promise<{ items: Array<{ value: string, label: string }> }>}
 */
export async function listSelectablePaymentMethods(opts = {}) {
  const { getAppUrl } = await import("./appUrl.js");
  const base = await getAppUrl();
  const url = new URL("/api/payment-methods/selectable", base);
  if (opts.sync) url.searchParams.set("sync", "1");
  const token = await getToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), { method: "GET", headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(toUserMessage(json.error || `HTTP ${res.status}`));
  }
  return { items: json.items ?? [] };
}
