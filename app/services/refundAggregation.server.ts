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

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

export type RefundAggregationLocationMode =
  | "order_transaction"
  | "refund_transaction_pos_location";

export type NonPosRefundFallbackMode = "order_retail_location" | "exclude";

export interface RefundAggregationContext {
  mode: RefundAggregationLocationMode;
  nonPosRefundFallbackMode: NonPosRefundFallbackMode;
  /** ショップ内で1件のみ: nonPosRefundAttributionEnabled のロケーション GID */
  nonPosRefundTargetLocationGid: string | null;
}

export interface OrderForRefundAggregation {
  id: string;
  retailLocation?: { id: string } | null;
  transactions?: Array<{
    id?: string;
    kind?: string;
    createdAt?: string;
    location?: { id: string } | null;
  }>;
  refunds?: Array<{
    createdAt?: string;
    transactions?: Array<{
      id?: string;
      kind?: string;
      location?: { id: string } | null;
    }>;
  }>;
}

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

/** GID 正規化 */
export function normalizeLocationGid(locationId: string | null | undefined): string | null {
  const s = String(locationId ?? "").trim();
  if (!s) return null;
  if (s.startsWith("gid://shopify/Location/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ? `gid://shopify/Location/${m[1]}` : null;
}

export function extractLocationNumericId(locationId: string | null | undefined): string | null {
  const gid = normalizeLocationGid(locationId);
  if (!gid) return null;
  return gid.replace("gid://shopify/Location/", "");
}

/** 精算対象ロケーションと GID が一致するか */
export function locationGidMatches(
  aggregationGid: string | null | undefined,
  settlementLocationId: string,
  locIdRaw: string,
): boolean {
  if (!aggregationGid) return false;
  const target = normalizeLocationGid(aggregationGid);
  if (!target) return false;
  const settlementGid = settlementLocationId.startsWith("gid://")
    ? settlementLocationId
    : `gid://shopify/Location/${locIdRaw}`;
  const aggRaw = extractLocationNumericId(target);
  return target === settlementGid || aggRaw === locIdRaw;
}

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

/** 返金トランザクション（refunds 配下）から POS ロケーション ID を取得 */
function getPosLocationFromRefundTransactions(
  order: OrderForRefundAggregation,
  inDay?: (iso?: string) => boolean,
): string | null {
  let latest: { ts: number; locationId: string } | null = null;

  for (const refund of order.refunds ?? []) {
    if (inDay && !inDay(refund.createdAt)) continue;
    const txs = refund.transactions ?? [];
    const nodes = Array.isArray(txs)
      ? txs
      : (txs as { nodes?: typeof txs }).nodes ?? [];

    for (const tx of nodes) {
      if (String(tx.kind ?? "").toUpperCase() !== "REFUND") continue;
      const locId = tx.location?.id;
      if (!locId) continue;
      const ts = refund.createdAt ? new Date(refund.createdAt).getTime() : 0;
      if (!latest || ts >= latest.ts) {
        latest = { ts, locationId: locId };
      }
    }
  }

  return latest ? normalizeLocationGid(latest.locationId) : null;
}

/** 注文に当日の返金があるか */
export function orderHasRefundInDay(
  order: OrderForRefundAggregation,
  inDay: (iso?: string) => boolean,
): boolean {
  for (const r of order.refunds ?? []) {
    if (inDay(r.createdAt)) return true;
  }
  for (const tx of order.transactions ?? []) {
    if (String(tx.kind ?? "").toUpperCase() === "REFUND" && inDay(tx.createdAt)) return true;
  }
  return false;
}

/**
 * 注文の返金をどのロケーションの精算に載せるかを決定する。
 */
export function resolveRefundAggregationLocationGid(
  order: OrderForRefundAggregation,
  ctx: RefundAggregationContext,
  inDay?: (iso?: string) => boolean,
): string | null {
  const retailGid = normalizeLocationGid(order.retailLocation?.id);
  const refundPosGid = getPosLocationFromRefundTransactions(order, inDay);

  if (ctx.mode === "refund_transaction_pos_location" && refundPosGid) {
    return refundPosGid;
  }

  if (refundPosGid) {
    // モードが order_transaction でも返金 TX に POS ロケーションがあれば注文基準で retail と同系
    return retailGid ?? refundPosGid;
  }

  // POS ロケーションが付かない返金（管理画面等）
  if (ctx.nonPosRefundTargetLocationGid) {
    return ctx.nonPosRefundTargetLocationGid;
  }

  if (ctx.nonPosRefundFallbackMode === "exclude") {
    return null;
  }

  return retailGid;
}

export async function fetchOrderForRefundAggregation(
  admin: AdminClient,
  orderGid: string,
): Promise<OrderForRefundAggregation | null> {
  const res = await admin.graphql(ORDER_FOR_REFUND_AGGREGATION_QUERY, {
    variables: { id: orderGid },
  });
  const json = (await res.json()) as {
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
  };

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

/** ロケーション保存時: nonPosRefundAttributionEnabled はショップ内1件のみ */
export function validateNonPosRefundAttributionLocations(
  locations: { id: string; nonPosRefundAttributionEnabled?: boolean }[],
): string | null {
  const enabled = locations.filter((l) => l.nonPosRefundAttributionEnabled === true);
  if (enabled.length > 1) {
    return "「POSロケーション以外の返金の計上先」は1つのロケーションだけにしてください。";
  }
  return null;
}
