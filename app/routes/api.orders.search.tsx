/**
 * GET /api/orders/search
 * 要件書 21.2: 注文検索（部分一致・日付・ロケーション・ページング）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";

const ORDERS_SEARCH_QUERY = `#graphql
  query OrdersSearch($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        totalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        customer {
          displayName
        }
        retailLocation {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** ロケーションIDを Shopify の location_id クエリ用の数値に正規化（GID の場合は末尾の数値のみ使用） */
function normalizeLocationIdForQuery(locationId: string | null | undefined): string | null {
  const s = locationId?.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/Location\/(\d+)$/) ?? s.match(/\/(\d+)$/);
  return m?.[1] ?? null;
}

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
  const locIdRaw = normalizeLocationIdForQuery(params.locationId);
  if (locIdRaw) {
    parts.push(`location_id:${locIdRaw}`);
    parts.push("source_name:pos");
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
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, corsJson } = authResult;
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
      return corsJson(
        { ok: false, error: "GraphQL error", details: json.errors },
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo ?? {};

    let items = nodes.map((node: Record<string, unknown>) => {
      const n = node as {
        id: string;
        name: string;
        createdAt: string;
        totalPriceSet?: { shopMoney?: { amount?: string } };
        customer?: { displayName?: string } | null;
        retailLocation?: { id: string; name: string } | null;
      };
      return {
        orderId: n.id?.replace("gid://shopify/Order/", "") ?? n.id,
        orderName: n.name,
        customerName: n.customer?.displayName ?? "",
        locationId: n.retailLocation?.id ?? "",
        locationName: n.retailLocation?.name ?? "",
        totalPrice: n.totalPriceSet?.shopMoney?.amount ?? "0",
        currency: "JPY",
        createdAt: n.createdAt,
      };
    });

    // locationId 指定時: retailLocation がそのロケーションの注文のみ返す（ロケーションなし・オンライン等を確実に除外）
    const requestedLocRaw = normalizeLocationIdForQuery(locationId);
    if (requestedLocRaw) {
      const locationGid = `gid://shopify/Location/${requestedLocRaw}`;
      items = items.filter((item) => {
        const rid = item.locationId?.trim();
        if (!rid) return false;
        return rid === locationGid || rid === requestedLocRaw || rid.endsWith(`/${requestedLocRaw}`);
      });
    }

    return corsJson(
      {
        items,
        nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
      },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
