/**
 * GET /api/locations
 * ショップのロケーション一覧と印字方式設定を返す
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import {
  getAppSetting,
  SALES_SUMMARY_SETTINGS_KEY,
  mergeAndNormalizeSalesSummarySettings,
  isFootfallReportingAllowedForLocation,
  type SalesSummarySettings,
} from "../utils/appSettings.server";

const LOCATIONS_QUERY = `#graphql
  query {
    locations(first: 50, includeLegacy: false) {
      nodes {
        id
        name
        isActive
      }
    }
  }
`;

/** デプロイ済みか確認する用。この文字列を変えれば「再デプロイ後」と分かる */
const PING_DIAGNOSTIC_VERSION = "2025-03-graphql-nodes-refund-nodes";

/** 認証不要の接続確認・切り分け用（?ping=1 で CORS 付き 200。graphqlTransactionsUseNodes は OrderTransactionConnection 修正済みかどうか） */
function corsPingResponse(request: Request): Response {
  const origin = request.headers.get("Origin") || "*";
  const body = {
    ok: true,
    message: "POS API is reachable",
    method: request.method,
    graphqlTransactionsUseNodes: true, // このキーがあれば transactions/refunds を nodes で取得する修正が入ったサーバー
    diagnosticVersion: PING_DIAGNOSTIC_VERSION, // ブラウザで /api/locations?ping=1 を開いて「この値が出ていれば」最新デプロイが動いている
  };
  return new Response(
    JSON.stringify(body),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Cache-Control": "no-store", // キャッシュで古い「修正済み: いいえ」が出ないようにする
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
    const nodes = (json.data as { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } })?.locations?.nodes ?? [];

    const dbLocations = await prisma.location.findMany({ where: { shopId: shop.id } });
    const dbMap = new Map(dbLocations.map((l) => [l.shopifyLocationGid, l]));

    const settings = await getAppSetting<Partial<SalesSummarySettings>>(shop.id, SALES_SUMMARY_SETTINGS_KEY);
    const merged = mergeAndNormalizeSalesSummarySettings(settings ?? undefined);

    const locations = nodes
      .filter((node) => node.isActive)
      .map((node) => {
        const db = dbMap.get(node.id);
        return {
          locationId: node.id,
          locationName: node.name,
          printMode: db?.printMode ?? "order_based",
          salesSummaryEnabled: db?.salesSummaryEnabled ?? false,
          footfallReportingEnabled: isFootfallReportingAllowedForLocation(merged, node.id),
        };
      });

    return corsJson({ locations }, { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

/** OPTIONS プリフライト対応（GET でも Authorization 付きだとブラウザが OPTIONS を送るため） */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
