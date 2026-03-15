/**
 * POS 売上サマリー API クライアント
 * 要件書 §21.6
 */
import { getAppUrl } from "./appUrl.js";
import { toUserMessage } from "./errorMessage.js";

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
    const statusSuffix = res.status ? ` (HTTP ${res.status})` : "";
    throw new Error(toUserMessage(msg) + statusSuffix);
  }
  return res.json();
}

/** 日次売上サマリー取得（算出・キャッシュ更新） */
export async function getDailySummary({ targetDate, locationIds = [] } = {}) {
  const params = new URLSearchParams();
  if (targetDate) params.set("targetDate", targetDate);
  for (const id of locationIds) params.append("locationIds[]", id);
  return apiFetch(`/api/sales-summary/daily?${params.toString()}`);
}

/** 期間売上サマリー取得 */
export async function getPeriodSummary({ dateFrom, dateTo, locationIds = [] } = {}) {
  const params = new URLSearchParams();
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  for (const id of locationIds) params.append("locationIds[]", id);
  return apiFetch(`/api/sales-summary/period?${params.toString()}`);
}

/** 入店数報告 */
export async function reportFootfall({ locationId, targetDate, visitors }) {
  return apiFetch("/api/footfall", {
    method: "POST",
    body: JSON.stringify({ locationId, targetDate, visitors }),
  });
}

/** 予算登録・更新 */
export async function upsertBudget({ locationId, targetDate, amount }) {
  return apiFetch("/api/budgets/upsert", {
    method: "POST",
    body: JSON.stringify({ locationId, targetDate, amount }),
  });
}

/** 予算一括インポート */
export async function importBudgets(rows) {
  return apiFetch("/api/budgets/import", {
    method: "POST",
    body: JSON.stringify({ rows }),
  });
}
