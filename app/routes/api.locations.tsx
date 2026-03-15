/**
 * GET /api/locations
 * ショップのロケーション一覧と印字方式設定を返す
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson } from "../utils/posAuth.server";
import prisma from "../db.server";

const LOCATIONS_QUERY = `#graphql
  query {
    locations(first: 50, includeLegacy: false) {
      edges {
        node {
          id
          name
          isActive
        }
      }
    }
  }
`;

/** 認証不要の接続確認用（?ping=1 で CORS 付き 200 を返す） */
function corsPingResponse(request: Request): Response {
  const origin = request.headers.get("Origin") || "*";
  return new Response(
    JSON.stringify({ ok: true, message: "POS API is reachable", method: request.method }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    }
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("ping") === "1") {
    return corsPingResponse(request);
  }

  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const response = await admin.graphql(LOCATIONS_QUERY);
    const json = await response.json();
    const edges = (json.data as { locations?: { edges?: { node: { id: string; name: string; isActive: boolean } }[] } })?.locations?.edges ?? [];

    const dbLocations = await prisma.location.findMany({ where: { shopId: shop.id } });
    const dbMap = new Map(dbLocations.map((l) => [l.shopifyLocationGid, l]));

    const locations = edges
      .filter((e) => e.node.isActive)
      .map((e) => {
        const node = e.node;
        const db = dbMap.get(node.id);
        return {
          locationId: node.id,
          locationName: node.name,
          printMode: db?.printMode ?? "order_based",
          salesSummaryEnabled: db?.salesSummaryEnabled ?? false,
          footfallReportingEnabled: db?.footfallReportingEnabled ?? false,
        };
      });

    return corsJson({ locations }, { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
