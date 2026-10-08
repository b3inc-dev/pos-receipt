/**
 * 返金の精算計上ロケーション（pos.refund_aggregation_location_gid）の解決
 */
import prisma from "../db.server";
import {
  getAppSetting,
  SETTLEMENT_SETTINGS_KEY,
  DEFAULT_SETTLEMENT_SETTINGS,
  type SettlementSettings,
} from "../utils/appSettings.server";
import { setOrderRefundAggregationLocationGid } from "./posOrderMetafields.server";
import { adminGraphqlWithRetry } from "../lib/shopifyGraphqlThrottle.server";
import {
  normalizeLocationGid,
  resolveRefundAggregationLocationGid,
  type OrderForRefundAggregation,
  type RefundAggregationContext,
} from "./refundAggregationPure.server";

export type {
  RefundAggregationLocationMode,
  NonPosRefundFallbackMode,
  RefundAggregationContext,
  OrderForRefundAggregation,
} from "./refundAggregationPure.server";

export {
  normalizeLocationGid,
  extractLocationNumericId,
  locationGidMatches,
  getPosLocationFromRefundTransactions,
  orderHasRefundInDay,
  resolveRefundAggregationLocationGid,
  validateNonPosRefundAttributionLocations,
} from "./refundAggregationPure.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const ORDER_FOR_REFUND_AGGREGATION_QUERY = `#graphql
  query OrderForRefundAggregation($id: ID!) {
    order(id: $id) {
      id
      retailLocation { id }
      transactions(first: 50) {
        id
        kind
        createdAt
        location { id }
      }
      refunds(first: 20) {
        createdAt
        transactions(first: 20) {
          nodes {
            id
            kind
            location { id }
          }
        }
      }
    }
  }
`;

export async function loadRefundAggregationContext(shopId: string): Promise<RefundAggregationContext> {
  const saved = await getAppSetting<Partial<SettlementSettings>>(shopId, SETTLEMENT_SETTINGS_KEY);
  const merged: SettlementSettings = { ...DEFAULT_SETTLEMENT_SETTINGS, ...saved };

  const nonPosLoc = await prisma.location.findFirst({
    where: { shopId, nonPosRefundAttributionEnabled: true },
    select: { shopifyLocationGid: true },
  });

  return {
    mode: merged.refundAggregationLocationMode ?? "order_transaction",
    nonPosRefundFallbackMode: merged.nonPosRefundFallbackMode ?? "order_retail_location",
    nonPosRefundTargetLocationGid: nonPosLoc?.shopifyLocationGid
      ? normalizeLocationGid(nonPosLoc.shopifyLocationGid)
      : null,
  };
}

export async function fetchOrderForRefundAggregation(
  admin: AdminClient,
  orderGid: string,
): Promise<OrderForRefundAggregation | null> {
  const json = await adminGraphqlWithRetry<{
    data?: {
      order?: {
        id: string;
        retailLocation?: { id: string } | null;
        transactions?: OrderForRefundAggregation["transactions"];
        refunds?: Array<{
          createdAt?: string;
          transactions?: { nodes?: unknown[] };
        }>;
      };
    };
  }>(
    admin,
    ORDER_FOR_REFUND_AGGREGATION_QUERY,
    { variables: { id: orderGid } },
    "refundAggregationOrder",
  );

  const node = json.data?.order;
  if (!node) return null;

  const refunds = (node.refunds ?? []).map((r) => ({
    createdAt: r.createdAt,
    transactions: (r.transactions?.nodes ?? []) as NonNullable<
      OrderForRefundAggregation["refunds"]
    >[number]["transactions"],
  }));

  return {
    id: node.id,
    retailLocation: node.retailLocation,
    transactions: node.transactions,
    refunds,
  };
}

function orderGidFromWebhookPayload(payload: unknown): string | null {
  const o = payload as Record<string, unknown>;
  if (typeof o.admin_graphql_api_id === "string" && o.admin_graphql_api_id.startsWith("gid://")) {
    return o.admin_graphql_api_id;
  }
  if (typeof o.id === "number" || typeof o.id === "string") {
    const n = String(o.id).replace(/\D/g, "");
    if (n) return `gid://shopify/Order/${n}`;
  }
  return null;
}

/** Webhook 等: 注文の pos.refund_aggregation_location_gid を再計算して保存 */
export async function syncRefundAggregationMetafieldForOrder(
  admin: AdminClient,
  shopId: string,
  orderGid: string,
): Promise<void> {
  const order = await fetchOrderForRefundAggregation(admin, orderGid);
  if (!order) return;

  const ctx = await loadRefundAggregationContext(shopId);
  const gid = resolveRefundAggregationLocationGid(order, ctx);
  await setOrderRefundAggregationLocationGid(admin, orderGid, gid);
}

/** REST orders/updated ペイロードから同期（返金があるときのみ） */
export async function syncRefundAggregationFromWebhookPayload(
  admin: AdminClient,
  shopId: string,
  payload: unknown,
): Promise<void> {
  const orderGid = orderGidFromWebhookPayload(payload);
  if (!orderGid) return;

  const body = payload as { refunds?: unknown[] };
  const hasRefundsArray = Array.isArray(body.refunds) && body.refunds.length > 0;
  if (!hasRefundsArray) {
    const order = await fetchOrderForRefundAggregation(admin, orderGid);
    if (!order || (order.refunds?.length ?? 0) === 0) return;
  }

  await syncRefundAggregationMetafieldForOrder(admin, shopId, orderGid);
}
