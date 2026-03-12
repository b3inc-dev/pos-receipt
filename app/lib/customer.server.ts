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
}

export interface GetMemberIdError {
  ok: false;
  error: "CUSTOMER_NOT_FOUND" | "MEMBER_ID_NOT_SET" | "API_ERROR";
}

export type GetMemberIdResponse = GetMemberIdResult | GetMemberIdError;

const FIRST_PAGE = 250;
const MAX_PAGES = 200;

type CustomersJson = {
  data?: {
    customers?: {
      edges?: Array<{
        node?: {
          id: string;
          metafield?: { value?: string } | null;
          lineMetafield?: { value?: string } | null;
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
 * 「socialplus.line が存在する顧客」のみ query で取得し、コード側で sub と照合する。
 * 値での絞り込みが効かない場合でも、ページネーションで全件照合できる。
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

    while (pageCount < MAX_PAGES) {
      const query = 'metafields.socialplus.line:*';
      const json = await runQuery(query, cursor);

      if (json.errors?.length) {
        console.error("Customer query errors:", json.errors);
        return { ok: false, error: "API_ERROR" };
      }

      const edges = json.data?.customers?.edges ?? [];
      const pageInfo = json.data?.customers?.pageInfo;

      for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        const lineValue = node.lineMetafield?.value;
        const lineMatch =
          typeof lineValue === "string" && lineValue.trim().toLowerCase() === lineIdNorm;
        if (!lineMatch) continue;

        const memberIdRaw = node.metafield?.value;
        const memberId =
          typeof memberIdRaw === "string" ? memberIdRaw.trim() : undefined;
        if (!memberId) {
          return { ok: false, error: "MEMBER_ID_NOT_SET" };
        }
        return { ok: true, memberId };
      }

      if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) {
        console.warn("[member-card] No matching customer. sub (last4):", lineIdNorm.slice(-4), "| ログイン中のLINEと顧客の socialplus.line が同一か確認してください");
        return { ok: false, error: "CUSTOMER_NOT_FOUND" };
      }

      cursor = pageInfo.endCursor;
      pageCount++;
    }

    console.warn("[member-card] Max pages reached. sub (last4):", lineIdNorm.slice(-4));
    return { ok: false, error: "CUSTOMER_NOT_FOUND" };
  } catch (err) {
    console.error("getMemberIdByLineId error:", err);
    return { ok: false, error: "API_ERROR" };
  }
}
