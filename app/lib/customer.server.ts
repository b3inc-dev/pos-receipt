/**
 * Shopify 顧客から socialplus.line で照合し、membership.id（会員番号）を取得する。
 * 照合・取得はサーバーのみで行う。
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const CUSTOMERS_QUERY = `#graphql
  query findCustomerByLineId($query: String!, $first: Int!, $after: String) {
    customers(first: $first, query: $query, after: $after) {
      edges {
        node {
          id
          metafield(namespace: "membership", key: "id") {
            value
          }
          lineMetafield: metafield(namespace: "socialplus", key: "line") {
            value
          }
          vipRankName: metafield(namespace: "vip", key: "rank_name") {
            value
          }
          vipPointsApproved: metafield(namespace: "vip", key: "points_approved") {
            value
          }
          vipRankDecisionPurchasePrice: metafield(namespace: "vip", key: "rank_decision_purchase_price") {
            value
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `#graphql
  mutation tagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

/** タグ検索のプレフィックス。例: "line:u1234..." */
const LINE_TAG_PREFIX = 'line:';

export interface GetMemberIdResult {
  ok: true;
  memberId: string;
  rankName?: string;
  pointsApproved?: string;
  /** ランク判定用累計購入額（円）。未設定時は undefined */
  rankDecisionPurchasePrice?: number;
}

export interface GetMemberIdError {
  ok: false;
  error: "CUSTOMER_NOT_FOUND" | "MEMBER_ID_NOT_SET" | "API_ERROR" | "THROTTLED";
}

export type GetMemberIdResponse = GetMemberIdResult | GetMemberIdError;

const FIRST_PAGE = 250;

/** リトライ上限（Throttled 時） */
const MAX_THROTTLE_RETRIES = 5;
/** 初回待機 ms、以降は指数バックオフ（2s → 4s → 8s → 16s → 32s） */
const THROTTLE_BACKOFF_MS = 2000;

/**
 * Shopify GraphQL の Throttled かどうかを判定する。
 * クライアントは GraphqlQueryError で message に "Throttled" を含めて投げる。
 */
function isThrottledError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = (err as Error & { message?: string }).message ?? "";
    return msg.includes("Throttled");
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** リトライし尽くしたときに投げる印 */
export class ThrottledExhaustedError extends Error {
  constructor() {
    super("Throttled: max retries exhausted");
    this.name = "ThrottledExhaustedError";
  }
}

/**
 * socialplus.line の値を LINE ユーザー ID に正規化する。
 * 生の "Uxxx..." または JSON（{"provider":"line","uid":"Uxxx..."} 等）の両方に対応。
 */
function normalizeStoredLineId(value: unknown): string | undefined {
  if (value == null) return undefined;
  const str = typeof value === "string" ? value.trim() : String(value).trim();
  if (!str) return undefined;
  try {
    const parsed = JSON.parse(str) as Record<string, unknown>;
    const id =
      parsed.uid ?? parsed.id ?? parsed.line_user_id ?? parsed.userId;
    const idStr = typeof id === "string" ? id.trim() : id != null ? String(id).trim() : "";
    return idStr || str;
  } catch {
    return str;
  }
}

type CustomersJson = {
  data?: {
    customers?: {
      edges?: Array<{
        node?: {
          id: string;
          metafield?: { value?: string } | null;
          lineMetafield?: { value?: string } | null;
          vipRankName?: { value?: string } | null;
          vipPointsApproved?: { value?: string } | null;
          vipRankDecisionPurchasePrice?: { value?: string } | null;
        };
      }>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
  errors?: Array<{ message?: string }>;
};

type CustomerNode = {
  id: string;
  metafield?: { value?: string } | null;
  lineMetafield?: { value?: string } | null;
  vipRankName?: { value?: string } | null;
  vipPointsApproved?: { value?: string } | null;
  vipRankDecisionPurchasePrice?: { value?: string } | null;
};

/** ノードからメンバー情報を組み立てる共通処理 */
function buildMemberResult(node: CustomerNode): GetMemberIdResult | GetMemberIdError {
  const memberIdRaw = node?.metafield?.value;
  const memberId = typeof memberIdRaw === "string" ? memberIdRaw.trim() : undefined;
  if (!memberId) return { ok: false, error: "MEMBER_ID_NOT_SET" };

  const rankNameRaw = node?.vipRankName?.value;
  const rankName = typeof rankNameRaw === "string" ? rankNameRaw.trim() || undefined : undefined;
  const pointsRaw = node?.vipPointsApproved?.value;
  const pointsApproved = typeof pointsRaw === "string" ? pointsRaw.trim() || undefined : undefined;
  const priceRaw = node?.vipRankDecisionPurchasePrice?.value;
  let rankDecisionPurchasePrice: number | undefined;
  if (priceRaw != null && priceRaw !== "") {
    const n = Number(priceRaw);
    if (!Number.isNaN(n) && n >= 0) rankDecisionPurchasePrice = n;
  }
  return { ok: true, memberId, rankName, pointsApproved, rankDecisionPurchasePrice };
}

/**
 * LINE user ID（sub）に一致する socialplus.line を持つ顧客を検索し、
 * その顧客の membership.id（会員番号）を返す。
 *
 * ファストパス: tag:"line:<lineUserId>" で1回検索（タグ登録済みの場合）。
 * スローパス:  metafields.socialplus.line:* で全件スキャン（ページ制限なし）。
 *              見つかった顧客に line: タグを fire-and-forget で追加し、次回からファストパスが効く。
 */
export async function getMemberIdByLineId(
  admin: AdminApiContext,
  lineUserId: string
): Promise<GetMemberIdResponse> {
  if (!lineUserId?.trim()) {
    return { ok: false, error: "CUSTOMER_NOT_FOUND" };
  }

  const lineIdNorm = lineUserId.trim().toLowerCase();
  console.info("[member-card] Searching for LINE sub (last4):", lineIdNorm.slice(-4));

  const runQuery = async (query: string, after: string | null): Promise<CustomersJson> => {
    const res = await admin.graphql(CUSTOMERS_QUERY, {
      variables: { query, first: FIRST_PAGE, after },
    });
    return (await res.json()) as CustomersJson;
  };

  const runQueryWithRetry = async (
    query: string,
    after: string | null
  ): Promise<CustomersJson> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
      try {
        return await runQuery(query, after);
      } catch (err) {
        lastErr = err;
        if (!isThrottledError(err)) throw err;
        if (attempt === MAX_THROTTLE_RETRIES) {
          console.warn("[member-card] Throttled after", MAX_THROTTLE_RETRIES, "retries, giving up");
          throw new ThrottledExhaustedError();
        }
        const baseMs = THROTTLE_BACKOFF_MS * Math.pow(2, attempt - 1);
        const jitterMs = Math.floor(baseMs * 0.3 * Math.random());
        const waitMs = baseMs + jitterMs;
        console.info("[member-card] Throttled, retry", attempt, "/", MAX_THROTTLE_RETRIES, "after", waitMs, "ms");
        await sleep(waitMs);
      }
    }
    throw lastErr;
  };

  try {
    // ── ファストパス: タグ検索（write_customers スコープ取得後、2回目以降に有効）──
    const lineTag = `${LINE_TAG_PREFIX}${lineIdNorm}`;
    const tagJson = await runQuery(`tag:"${lineTag}"`, null).catch(() => null);
    if (tagJson && !tagJson.errors?.length) {
      const tagEdges = tagJson.data?.customers?.edges ?? [];
      for (const edge of tagEdges) {
        const node = edge?.node;
        if (!node) continue;
        const storedLineId = normalizeStoredLineId(node.lineMetafield?.value);
        if (!storedLineId || storedLineId.toLowerCase() !== lineIdNorm) continue;
        console.info("[member-card] Cache hit via tag (last4):", lineIdNorm.slice(-4));
        return buildMemberResult(node);
      }
    }

    // ── スローパス: 全件スキャン（件数制限なし）──
    console.info("[member-card] Tag miss. Falling back to full scan (last4):", lineIdNorm.slice(-4));
    let cursor: string | null = null;
    let pageCount = 0;

    while (true) {
      const json = await runQueryWithRetry('metafields.socialplus.line:*', cursor);

      if (json.errors?.length) {
        console.error("Customer query errors:", json.errors);
        return { ok: false, error: "API_ERROR" };
      }

      const edges = json.data?.customers?.edges ?? [];
      const pageInfo = json.data?.customers?.pageInfo;

      if (pageCount === 0) {
        if (edges.length === 0) {
          console.warn("[member-card] metafields.socialplus.line:* returned 0 customers.");
          return { ok: false, error: "CUSTOMER_NOT_FOUND" };
        }
        console.info("[member-card] Full scan first page:", edges.length, "customers");
      }

      for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        const storedLineId = normalizeStoredLineId(node.lineMetafield?.value);
        if (!storedLineId || storedLineId.toLowerCase() !== lineIdNorm) continue;

        // タグを追加して次回からファストパスが効くようにする（fire-and-forget）
        admin.graphql(TAGS_ADD_MUTATION, { variables: { id: node.id, tags: [lineTag] } })
          .then(async (res) => {
            const j = await res.json() as { data?: { tagsAdd?: { userErrors?: Array<{ message?: string }> } } };
            const errs = j.data?.tagsAdd?.userErrors;
            if (errs?.length) console.warn("[member-card] tagsAdd userErrors:", errs);
            else console.info("[member-card] Tag added for future fast lookup (last4):", lineIdNorm.slice(-4));
          })
          .catch((e) => console.warn("[member-card] tagsAdd failed:", e));

        return buildMemberResult(node);
      }

      if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) {
        console.warn("[member-card] No match found. sub (last4):", lineIdNorm.slice(-4));
        return { ok: false, error: "CUSTOMER_NOT_FOUND" };
      }

      cursor = pageInfo.endCursor;
      pageCount++;
    }
  } catch (err) {
    if (err instanceof ThrottledExhaustedError) {
      return { ok: false, error: "THROTTLED" };
    }
    console.error("getMemberIdByLineId error:", err);
    return { ok: false, error: "API_ERROR" };
  }
}
