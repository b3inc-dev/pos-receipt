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
          lineMetafield: metafield(namespace: "socialplus", key: "line") {
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
 * 取得結果は socialplus.line をコード側で照合し、完全一致した顧客のみ採用する
 * （metafield が検索可能でない場合でも正しい顧客を返すため）。
 */
export async function getMemberIdByLineId(
  admin: AdminApiContext,
  lineUserId: string
): Promise<GetMemberIdResponse> {
  if (!lineUserId?.trim()) {
    return { ok: false, error: "CUSTOMER_NOT_FOUND" };
  }

  const lineIdNorm = lineUserId.trim().toLowerCase();
  const escaped = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const runQuery = async (queryValue: string) => {
    const q = `metafields.socialplus.line:"${escaped(queryValue)}"`;
    const res = await admin.graphql(CUSTOMERS_QUERY, {
      variables: { query: q, first: 50 },
    });
    return res;
  };

  try {
    let res = await runQuery(lineIdNorm);
    let json = (await res.json()) as {
      data?: { customers?: { edges?: Array<{ node?: { id: string; metafield?: { value?: string } | null; lineMetafield?: { value?: string } | null } }> } };
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      console.error("Customer query errors:", json.errors);
      return { ok: false, error: "API_ERROR" };
    }
    let edges = json.data?.customers?.edges ?? [];
    if (edges.length === 0 && lineUserId.trim() !== lineIdNorm) {
      res = await runQuery(lineUserId.trim());
      json = (await res.json()) as typeof json;
      if (json.errors?.length) {
        console.error("Customer query errors (retry):", json.errors);
        return { ok: false, error: "API_ERROR" };
      }
      edges = json.data?.customers?.edges ?? [];
    }

    if (edges.length === 0) {
      console.warn("[member-card] No customers in query result. sub (last4):", lineIdNorm.slice(-4), "| Check metafield 'ストア分析で絞り込む' for socialplus.line");
    } else {
      const sampleLine = edges[0]?.node?.lineMetafield?.value;
      console.warn("[member-card] Query returned", edges.length, "customers but no line match. sub (last4):", lineIdNorm.slice(-4), "| sample lineMetafield (last4):", typeof sampleLine === "string" ? sampleLine.slice(-4) : sampleLine);
    }

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

    return { ok: false, error: "CUSTOMER_NOT_FOUND" };
  } catch (err) {
    console.error("getMemberIdByLineId error:", err);
    return { ok: false, error: "API_ERROR" };
  }
}
