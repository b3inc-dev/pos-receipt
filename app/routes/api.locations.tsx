/**
 * GET /api/locations
 * ショップのロケーション一覧と印字方式設定を返す
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticatePosRequest } from "../utils/posAuth.server";
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

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, shop, corsJson } = await authenticatePosRequest(request);

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
    return corsJson({ ok: false, error: message }, { status: 500 });
  }
}
