/**
 * POS 内蔵の Shopify Admin GraphQL API（shopify:admin/api/graphql.json）を呼ぶ共通モジュール。
 * POS Stock と同様、自社バックエンドを経由せずにロケーション等を取得するため、
 * タイル／モーダルの「Load failed」を防ぐ。
 */

const LOCATIONS_QUERY = `#graphql
  query Locations($first: Int!) {
    locations(first: $first, includeLegacy: false) {
      nodes {
        id
        name
        isActive
      }
    }
  }
`;

/**
 * Shopify 内蔵 GraphQL を実行する（POS が認証を処理するためトークン不要）
 * @param {string} query - GraphQL クエリ
 * @param {Record<string, unknown>} [variables] - 変数
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<Record<string, unknown>>} json.data
 */
export async function adminGraphql(query, variables = {}, opts = {}) {
  const timeoutMs = Number.isFinite(Number(opts?.timeoutMs)) ? Number(opts.timeoutMs) : 20000;
  const controller = new AbortController();
  const parentSignal = opts?.signal;
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let done = false;
  let iv = null;
  const timeoutPromise = new Promise((_, reject) => {
    const started = Date.now();
    iv = setInterval(() => {
      if (done) return;
      if (Date.now() - started >= timeoutMs) {
        controller.abort(new Error(`timeout ${timeoutMs}ms`));
        reject(new Error(`timeout ${timeoutMs}ms`));
      }
    }, 200);
  });

  const fetchPromise = (async () => {
    const res = await fetch("shopify:admin/api/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    const json = text ? JSON.parse(text) : {};
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    return json.data ?? {};
  })();

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    done = true;
    if (iv) clearInterval(iv);
  }
}

/**
 * ロケーション一覧を Shopify 内蔵 API から取得（バックエンド不要）。
 * 戻り値は api/locations と似た形に揃える（printMode はデフォルト）。
 */
export async function getLocationsFromShopify(first = 50) {
  const data = await adminGraphql(LOCATIONS_QUERY, { first });
  const nodes = Array.isArray(data?.locations?.nodes) ? data.locations.nodes : [];
  return {
    locations: nodes
      .filter((n) => n?.isActive !== false)
      .map((n) => ({
        locationId: n.id,
        locationName: n.name ?? "",
        printMode: "order_based",
        salesSummaryEnabled: false,
        footfallReportingEnabled: false,
      })),
  };
}
