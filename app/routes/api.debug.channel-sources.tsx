/**
 * GET /api/debug/channel-sources
 * デバッグ用: 直近注文の source_name 分布を確認する
 * チャネル別集計実装前に source_name の実値を把握するために使用
 *
 * Query:
 *   days     - 何日分遡るか（default: 30, max: 90）
 *   limit    - 1クエリの取得件数（default: 250, max: 250）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";

const CHANNEL_SOURCES_QUERY = `#graphql
  query DebugChannelSources($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        sourceName
        channelInformation {
          channelDefinition {
            channelName
            handle
          }
          app {
            name
          }
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

type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  sourceName: string | null;
  channelInformation?: {
    channelDefinition?: { channelName?: string; handle?: string } | null;
    app?: { name?: string } | null;
  } | null;
  retailLocation?: { id: string; name: string } | null;
};

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, corsJson } = authResult;

    const url = new URL(request.url);
    const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
    const limit = Math.min(250, Math.max(1, parseInt(url.searchParams.get("limit") ?? "250", 10) || 250));

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const shopifyQuery = `created_at:>=${since} -status:cancelled tag_not:settlement`;

    // 最大2ページ（500件）まで取得してサンプルとする
    const allOrders: OrderNode[] = [];
    let cursor: string | null = null;
    let pages = 0;
    const maxPages = 2;

    while (pages < maxPages) {
      const response = await admin.graphql(CHANNEL_SOURCES_QUERY, {
        variables: { first: limit, after: cursor, query: shopifyQuery },
      });
      const json = await response.json();
      if (json.errors?.length) {
        return corsJson({ ok: false, error: "GraphQL error", details: json.errors }, { status: 500 });
      }
      const nodes: OrderNode[] = json.data?.orders?.nodes ?? [];
      allOrders.push(...nodes);
      const pageInfo = json.data?.orders?.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
      pages++;
    }

    // source_name 別に集計
    const sourceNameMap = new Map<string, {
      count: number;
      channelNames: Set<string>;
      appNames: Set<string>;
      hasRetailLocation: number;
      samples: Array<{ orderId: string; orderName: string; createdAt: string }>;
    }>();

    for (const order of allOrders) {
      const src = order.sourceName ?? "(null)";
      if (!sourceNameMap.has(src)) {
        sourceNameMap.set(src, {
          count: 0,
          channelNames: new Set(),
          appNames: new Set(),
          hasRetailLocation: 0,
          samples: [],
        });
      }
      const entry = sourceNameMap.get(src)!;
      entry.count++;
      if (order.channelInformation?.channelDefinition?.channelName) {
        entry.channelNames.add(order.channelInformation.channelDefinition.channelName);
      }
      if (order.channelInformation?.channelDefinition?.handle) {
        entry.channelNames.add(`[handle: ${order.channelInformation.channelDefinition.handle}]`);
      }
      if (order.channelInformation?.app?.name) {
        entry.appNames.add(order.channelInformation.app.name);
      }
      if (order.retailLocation) {
        entry.hasRetailLocation++;
      }
      if (entry.samples.length < 3) {
        entry.samples.push({
          orderId: order.id.replace("gid://shopify/Order/", ""),
          orderName: order.name,
          createdAt: order.createdAt,
        });
      }
    }

    const breakdown = Array.from(sourceNameMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([sourceName, data]) => ({
        sourceName,
        count: data.count,
        channelNames: Array.from(data.channelNames),
        appNames: Array.from(data.appNames),
        hasRetailLocation: data.hasRetailLocation,
        noRetailLocation: data.count - data.hasRetailLocation,
        samples: data.samples,
      }));

    return corsJson({
      ok: true,
      meta: {
        queriedDays: days,
        totalOrdersScanned: allOrders.length,
        since,
      },
      breakdown,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
