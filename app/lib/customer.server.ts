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
  error: "CUSTOMER_NOT_FOUND" | "MEMBER_ID_NOT_SET" | "API_ERROR";
}

export type GetMemberIdResponse = GetMemberIdResult | GetMemberIdError;

const FIRST_PAGE = 250;
const MAX_PAGES = 200;

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

/**
 * LINE user ID（sub）に一致する socialplus.line を持つ顧客を検索し、
 * その顧客の membership.id（会員番号）を返す。
 * Admin API の customers 検索ではメタフィールド「値」での絞り込みができないため、
 * 「socialplus.line が存在する顧客」を query で取得し、コード側で sub と照合する。
 * ページネーション（最大 50,000 件）で全件照合する現状が、この前提では一般的な実装。
 */
export async function getMemberIdByLineId(
  admin: AdminApiContext,
  lineUserId: string
): Promise<GetMemberIdResponse> {
  if (!lineUserId?.trim()) {
    return { ok: false, error: "CUSTOMER_NOT_FOUND" };
  }

  const lineIdNorm = lineUserId.trim().toLowerCase();
  console.info("[member-card] Searching for LINE sub (last4):", lineIdNorm.slice(-4), "| 照合する顧客の socialplus.line 末尾4文字と一致するか確認してください");

  const runQuery = async (query: string, after: string | null): Promise<CustomersJson> => {
    const res = await admin.graphql(CUSTOMERS_QUERY, {
      variables: { query, first: FIRST_PAGE, after },
    });
    return (await res.json()) as CustomersJson;
  };

  try {
    let cursor: string | null = null;
    let pageCount = 0;
    let firstPageEdgeCount: number | null = null;

    while (pageCount < MAX_PAGES) {
      const query = 'metafields.socialplus.line:*';
      const json = await runQuery(query, cursor);

      if (json.errors?.length) {
        console.error("Customer query errors:", json.errors);
        return { ok: false, error: "API_ERROR" };
      }

      const edges = json.data?.customers?.edges ?? [];
      const pageInfo = json.data?.customers?.pageInfo;

      if (pageCount === 0) {
        firstPageEdgeCount = edges.length;
        if (edges.length === 0) {
          console.warn("[member-card] Query metafields.socialplus.line:* returned 0 customers. フィルタが効いているか、該当メタフィールドを持つ顧客がいるか確認してください。");
        } else {
          console.info("[member-card] First page:", edges.length, "customers (query: metafields.socialplus.line:*)");
        }
      }

      for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        const storedLineId = normalizeStoredLineId(node.lineMetafield?.value);
        const lineMatch =
          !!storedLineId && storedLineId.toLowerCase() === lineIdNorm;
        if (!lineMatch) continue;

        const memberIdRaw = node.metafield?.value;
        const memberId =
          typeof memberIdRaw === "string" ? memberIdRaw.trim() : undefined;
        if (!memberId) {
          return { ok: false, error: "MEMBER_ID_NOT_SET" };
        }
        const rankNameRaw = node.vipRankName?.value;
        const rankName =
          typeof rankNameRaw === "string" ? rankNameRaw.trim() || undefined : undefined;
        const pointsRaw = node.vipPointsApproved?.value;
        const pointsApproved =
          typeof pointsRaw === "string" ? pointsRaw.trim() || undefined : undefined;
        const priceRaw = node.vipRankDecisionPurchasePrice?.value;
        let rankDecisionPurchasePrice: number | undefined;
        if (priceRaw != null && priceRaw !== "") {
          const n = Number(priceRaw);
          if (!Number.isNaN(n) && n >= 0) rankDecisionPurchasePrice = n;
        }
        return { ok: true, memberId, rankName, pointsApproved, rankDecisionPurchasePrice };
      }

      if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) {
        const hint =
          firstPageEdgeCount === 0
            ? "初回クエリが0件です。metafields.socialplus.line:* が効いていないか、該当顧客がいません。"
            : "ログイン中のLINEと顧客の socialplus.line（または JSON 内 uid）が同一か、同一チャネルか確認してください。";
        console.warn("[member-card] No matching customer. sub (last4):", lineIdNorm.slice(-4), "|", hint);
        return { ok: false, error: "CUSTOMER_NOT_FOUND" };
      }

      cursor = pageInfo.endCursor;
      pageCount++;
    }

    const totalScanned = pageCount * FIRST_PAGE;
    console.warn(
      "[member-card] Max pages reached. Scanned",
      pageCount,
      "pages (",
      totalScanned,
      "customers with socialplus.line). sub (last4):",
      lineIdNorm.slice(-4),
      "| 該当する顧客が先頭",
      totalScanned,
      "件にいないか、ログイン中のLINEと顧客の socialplus.line が一致していません。"
    );
    return { ok: false, error: "CUSTOMER_NOT_FOUND" };
  } catch (err) {
    console.error("getMemberIdByLineId error:", err);
    return { ok: false, error: "API_ERROR" };
  }
}
