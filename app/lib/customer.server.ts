/**
 * Shopify 顧客から socialplus.line で照合し、membership.id（会員番号）を取得する。
 * 照合・取得はサーバーのみで行う。
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const CUSTOMERS_QUERY = `#graphql
  query findCustomerByLineId($query: String!, $first: Int!) {
    customers(first: $first, query: $query) {
      edges {
        node {
          id
          metafield(namespace: "membership", key: "id") {
            value
          }
        }
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

/**
 * LINE user ID（sub）に一致する socialplus.line を持つ顧客を検索し、
 * その顧客の membership.id（会員番号）を返す。
 * 顧客検索は first で件数制限（安全のため最大 5 件まで取得して先頭を採用）。
 */
export async function getMemberIdByLineId(
  admin: AdminApiContext,
  lineUserId: string
): Promise<GetMemberIdResponse> {
  if (!lineUserId?.trim()) {
    return { ok: false, error: "CUSTOMER_NOT_FOUND" };
  }

  const escaped = lineUserId.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const query = `metafields.socialplus.line:"${escaped}"`;

  try {
    const res = await admin.graphql(CUSTOMERS_QUERY, {
      variables: { query, first: 5 },
    });
    const json = (await res.json()) as {
      data?: {
        customers?: {
          edges?: Array<{
            node?: {
              id: string;
              metafield?: { value?: string } | null;
            };
          }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (json.errors?.length) {
      console.error("Customer query errors:", json.errors);
      return { ok: false, error: "API_ERROR" };
    }

    const edges = json.data?.customers?.edges ?? [];
    const node = edges[0]?.node;
    if (!node) {
      return { ok: false, error: "CUSTOMER_NOT_FOUND" };
    }

    const memberIdRaw = node.metafield?.value;
    const memberId =
      typeof memberIdRaw === "string" ? memberIdRaw.trim() : undefined;
    if (!memberId) {
      return { ok: false, error: "MEMBER_ID_NOT_SET" };
    }

    return { ok: true, memberId };
  } catch (err) {
    console.error("getMemberIdByLineId error:", err);
    return { ok: false, error: "API_ERROR" };
  }
}
