/**
 * GET /api/orders/search
 * 要件書 21.2: 注文検索（部分一致・日付・ロケーション・ページング）
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const ORDERS_SEARCH_QUERY = `#graphql
  query OrdersSearch($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          name
          createdAt
          totalPriceSet { shopMoney { amount } }
          displayFinancialStatus
          customer {
            displayName
          }
          location {
            id
            name
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

function buildSearchQuery(params: {
  q?: string | null;
  locationId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}): string | undefined {
  const parts: string[] = [];
  if (params.q?.trim()) {
    const term = params.q.trim().replace(/^#/, "");
    // 数字のみ: 注文番号として name で検索。それ以外: 複数フィールドの検索用にそのまま
    if (/^\d+$/.test(term)) {
      parts.push(`name:${term}`);
    } else {
      parts.push(params.q.trim());
    }
  }
  if (params.locationId?.trim()) {
    parts.push(`location_id:${params.locationId.trim()}`);
  }
  if (params.dateFrom) {
    parts.push(`created_at:>=${params.dateFrom}T00:00:00Z`);
  }
  if (params.dateTo) {
    parts.push(`created_at:<=${params.dateTo}T23:59:59Z`);
  }
  if (parts.length === 0) return undefined;
  return parts.join(" AND ");
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin } = await authenticate.public(request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    const locationId = url.searchParams.get("locationId");
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const cursor = url.searchParams.get("cursor");
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));

    const query = buildSearchQuery({ q, locationId, dateFrom, dateTo });

    const response = await admin.graphql(ORDERS_SEARCH_QUERY, {
      variables: { first: limit, after: cursor || null, query: query || null },
    });

    const json = await response.json();
    if (json.errors?.length) {
      return Response.json(
        { ok: false, error: "GraphQL error", details: json.errors },
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const edges = json.data?.orders?.edges ?? [];
    const pageInfo = json.data?.orders?.pageInfo ?? {};

    const items = edges.map((edge: { cursor: string; node: Record<string, unknown> }) => {
      const node = edge.node as {
        id: string;
        name: string;
        createdAt: string;
        totalPriceSet?: { shopMoney?: { amount?: string } };
        customer?: { displayName?: string } | null;
        location?: { id: string; name: string } | null;
      };
      return {
        orderId: node.id?.replace("gid://shopify/Order/", "") ?? node.id,
        orderName: node.name,
        customerName: node.customer?.displayName ?? "",
        locationId: node.location?.id ?? "",
        locationName: node.location?.name ?? "",
        totalPrice: node.totalPriceSet?.shopMoney?.amount ?? "0",
        currency: "JPY",
        createdAt: node.createdAt,
      };
    });

    return Response.json(
      {
        items,
        nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
      },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      { ok: false, error: message },
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
