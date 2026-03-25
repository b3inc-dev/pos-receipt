/**
 * Sales Channel Engine
 * チャネル別売上集計（仮想ロケーション）
 *
 * - POS ロケーションとは独立して動作する（retailLocation 照合なし）
 * - Shopify の source_name フィールドでチャネルを識別する
 * - 返金は updated_at ベースの 2 パスで集計（POS の settlementEngine と同方式）
 * - キャッシュは SalesChannelCacheDaily に保存
 */
import prisma from "../db.server";
import { getShopTimezoneForDaily, getDayRangeInUtc } from "../utils/shopTimezone.server";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChannelDailySummaryDTO {
  channelId: string;
  channelName: string;
  targetDate: string;
  actual: number;
  orders: number;
  items: number;
  budget: number | null;
  budgetRatio: number | null;
  atv: number | null;
  setRate: number | null;
  unit: number | null;
  currency: string;
}

// ── Shopify Types ──────────────────────────────────────────────────────────────

interface ChannelOrder {
  id: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { nodes: { quantity: number }[] };
  refunds: ChannelRefund[];
  tags: string[];
}

interface ChannelRefund {
  createdAt?: string;
  totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } };
  refundLineItems?: { quantity: number }[];
}

interface OrderForRefundOverlay {
  id: string;
  tags: string[];
  refunds: ChannelRefund[];
}

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

// ── GraphQL Queries ────────────────────────────────────────────────────────────

const CHANNEL_ORDERS_QUERY = `#graphql
  query ChannelOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      nodes {
        id
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 250) {
          nodes { quantity }
        }
        refunds {
          createdAt
          refundLineItems(first: 250) {
            nodes { quantity }
          }
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
        tags
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CHANNEL_REFUNDS_QUERY = `#graphql
  query ChannelRefundsOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes {
        id
        tags
        refunds {
          createdAt
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ── Query Builder ──────────────────────────────────────────────────────────────

/**
 * source_name フィルターを含む Shopify クエリ文字列を構築する。
 * 複数 source_name は OR 条件で結合する。
 */
function buildChannelQuery(
  sourceNames: string[],
  dateField: "created_at" | "updated_at",
  startIso: string,
  endIso: string,
  extraFilters: string[] = []
): string {
  const parts: string[] = [];

  if (sourceNames.length === 1) {
    parts.push(`source_name:${sourceNames[0]}`);
  } else if (sourceNames.length > 1) {
    // Shopify の OR クエリ構文
    parts.push(`(${sourceNames.map((s) => `source_name:${s}`).join(" OR ")})`);
  }

  parts.push(`${dateField}:>=${startIso}`);
  parts.push(`${dateField}:<=${endIso}`);
  parts.push(...extraFilters);

  return parts.join(" ");
}

// ── Fetch Helpers ──────────────────────────────────────────────────────────────

async function fetchChannelOrders(admin: AdminClient, query: string): Promise<ChannelOrder[]> {
  const orders: ChannelOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(CHANNEL_ORDERS_QUERY, {
      variables: { first: 100, after: cursor, query },
    });
    const json = await response.json() as {
      data?: {
        orders?: {
          nodes?: Array<ChannelOrder & {
            refunds?: Array<ChannelRefund & { refundLineItems?: { nodes?: { quantity: number }[] } | { quantity: number }[] }>;
          }>;
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const node of nodes) {
      const isSettlement = (node.tags ?? []).some((t) => String(t).toLowerCase() === "settlement");
      if (!isSettlement) {
        orders.push({
          ...node,
          refunds: (node.refunds ?? []).map((r) => {
            const raw = r.refundLineItems as unknown;
            const refundLineItems: { quantity: number }[] = Array.isArray(raw)
              ? raw as { quantity: number }[]
              : (raw && typeof raw === "object" && "nodes" in raw)
                ? ((raw as { nodes?: { quantity: number }[] }).nodes ?? [])
                : [];
            return { ...r, refundLineItems };
          }),
        });
      }
    }

    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
  }

  return orders;
}

async function fetchChannelOrdersForRefundOverlay(
  admin: AdminClient,
  query: string
): Promise<OrderForRefundOverlay[]> {
  const orders: OrderForRefundOverlay[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(CHANNEL_REFUNDS_QUERY, {
      variables: { first: 100, after: cursor, query },
    });
    const json = await response.json() as {
      data?: {
        orders?: {
          nodes?: OrderForRefundOverlay[];
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const node of nodes) {
      const isSettlement = (node.tags ?? []).some((t) => String(t).toLowerCase() === "settlement");
      if (!isSettlement) {
        orders.push({ id: node.id, tags: node.tags, refunds: node.refunds ?? [] });
      }
    }

    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
  }

  return orders;
}

// ── 集計ロジック ───────────────────────────────────────────────────────────────

/** 当日作成注文から gross 売上・返金・商品数を集計 */
function computeChannelTotalsFromOrders(
  orders: ChannelOrder[],
  dayRange: { startUtc: Date; endUtc: Date }
): { gross: number; refund: number; items: number; currency: string } {
  let gross = 0;
  let refund = 0;
  let items = 0;
  let currency = "JPY";

  for (const order of orders) {
    gross += Number(order.totalPriceSet?.shopMoney?.amount ?? 0);
    currency = order.totalPriceSet?.shopMoney?.currencyCode ?? currency;

    for (const li of order.lineItems?.nodes ?? []) {
      items += li.quantity;
    }

    for (const r of order.refunds ?? []) {
      if (!r.createdAt) continue;
      const t = new Date(r.createdAt).getTime();
      if (t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime()) {
        refund += Number(r.totalRefundedSet?.shopMoney?.amount ?? 0);
      }
    }
  }

  return { gross, refund, items, currency };
}

/**
 * 返金 overlay: 当日 updated_at で更新されたが当日 created_at ではない注文からの返金を拾う
 * （GAS overlayRefundsAndRecalc 相当、POS の settlementEngine と同方式）
 */
function computeRefundOverlay(
  ordersUpdated: OrderForRefundOverlay[],
  orderIdsCreatedInDay: Set<string>,
  dayRange: { startUtc: Date; endUtc: Date }
): number {
  let overlay = 0;
  for (const order of ordersUpdated) {
    if (orderIdsCreatedInDay.has(order.id)) continue;
    for (const r of order.refunds ?? []) {
      if (!r.createdAt) continue;
      const t = new Date(r.createdAt).getTime();
      if (t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime()) {
        overlay += Number(r.totalRefundedSet?.shopMoney?.amount ?? 0);
      }
    }
  }
  return overlay;
}

// ── sourceNamesSnapshot によるキャッシュ有効性チェック ──────────────────────────

function isSnapshotMismatch(channel: { sourceNamesJson: string; sourceNamesSnapshot: string }): boolean {
  return channel.sourceNamesJson !== channel.sourceNamesSnapshot;
}

// ── メインエントリ ─────────────────────────────────────────────────────────────

export async function computeAndCacheChannelDailySummary(
  admin: AdminClient,
  shopId: string,
  channelId: string,
  channelName: string,
  sourceNames: string[],
  targetDate: string
): Promise<ChannelDailySummaryDTO> {
  if (sourceNames.length === 0) {
    throw new Error(`SalesChannel "${channelName}" has no sourceNames configured.`);
  }

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dayRange = getDayRangeInUtc(targetDate, timezone);

  // Pass 1: created_at ベース（当日注文）
  const createdQuery = buildChannelQuery(
    sourceNames,
    "created_at",
    dayRange.startUtcIso,
    dayRange.endUtcIso,
    ["tag_not:settlement", "-status:cancelled"]
  );
  const orders = await fetchChannelOrders(admin, createdQuery);
  const orderIdsCreatedInDay = new Set(orders.map((o) => o.id));
  const { gross, refund: refundInDay, items, currency } = computeChannelTotalsFromOrders(orders, dayRange);

  // Pass 2: updated_at ベース返金 overlay（当日以外の注文から当日処理された返金）
  const updatedQuery = buildChannelQuery(
    sourceNames,
    "updated_at",
    dayRange.startUtcIso,
    dayRange.endUtcIso,
    ["tag_not:settlement"]
  );
  const ordersUpdated = await fetchChannelOrdersForRefundOverlay(admin, updatedQuery);
  const refundOverlay = computeRefundOverlay(ordersUpdated, orderIdsCreatedInDay, dayRange);

  const actual = gross - refundInDay - refundOverlay;
  const orderCount = orders.length;

  // 予算取得
  const budget = await prisma.salesChannelBudget?.findFirst?.({
    where: { shopId, channelId, targetDate },
  }).catch(() => null) ?? null;
  const budgetAmount: number | null = budget ? Number((budget as { amount: unknown }).amount) : null;

  // KPI 算出
  const budgetRatio = budgetAmount && budgetAmount > 0 ? actual / budgetAmount : null;
  const atv = orderCount > 0 ? actual / orderCount : null;
  const setRate = orderCount > 0 ? items / orderCount : null;
  const unit = items > 0 ? actual / items : null;

  // sourceNamesJson（マッピング変更検知用スナップショット）
  const sourceNamesJson = JSON.stringify([...sourceNames].sort());

  // キャッシュ保存
  await prisma.salesChannelCacheDaily.upsert({
    where: { shopId_channelId_targetDate: { shopId, channelId, targetDate } },
    update: {
      actual,
      orders: orderCount,
      items,
      budget: budgetAmount,
      budgetRatio,
      atv,
      setRate,
      unit,
      currency,
    },
    create: {
      shopId,
      channelId,
      targetDate,
      actual,
      orders: orderCount,
      items,
      budget: budgetAmount,
      budgetRatio,
      atv,
      setRate,
      unit,
      currency,
    },
  });

  // sourceNamesSnapshot を更新（マッピング変更検知のため）
  await prisma.salesChannel.update({
    where: { id: channelId },
    data: { sourceNamesSnapshot: sourceNamesJson },
  });

  return { channelId, channelName, targetDate, actual, orders: orderCount, items, budget: budgetAmount, budgetRatio, atv, setRate, unit, currency };
}

// ── キャッシュ読み取り（API エンドポイントから使用） ──────────────────────────────

export async function getChannelDailySummariesFromCache(
  shopId: string,
  channelIds: string[],
  targetDate: string
): Promise<ChannelDailySummaryDTO[]> {
  const channels = await prisma.salesChannel.findMany({
    where: { shopId, id: { in: channelIds }, salesSummaryEnabled: true },
  });
  const caches = await prisma.salesChannelCacheDaily.findMany({
    where: { shopId, channelId: { in: channelIds }, targetDate },
  });
  const cacheMap = new Map(caches.map((c) => [c.channelId, c]));

  return channels.map((ch) => {
    const c = cacheMap.get(ch.id);
    if (!c) return null;
    // sourceNamesSnapshot が現在設定と異なる場合、このキャッシュは古い（呼び出し元で再計算すること）
    if (isSnapshotMismatch(ch)) return null;
    return {
      channelId: ch.id,
      channelName: ch.displayName ?? ch.name,
      targetDate,
      actual: Number(c.actual),
      orders: c.orders,
      items: c.items,
      budget: c.budget ? Number(c.budget) : null,
      budgetRatio: c.budgetRatio ? Number(c.budgetRatio) : null,
      atv: c.atv ? Number(c.atv) : null,
      setRate: c.setRate ? Number(c.setRate) : null,
      unit: c.unit ? Number(c.unit) : null,
      currency: c.currency,
    };
  }).filter((r): r is ChannelDailySummaryDTO => r !== null);
}

/** 有効なチャネル一覧を返す（salesSummaryEnabled=true のみ） */
export async function getEnabledSalesChannels(shopId: string) {
  const channels = await prisma.salesChannel.findMany({
    where: { shopId, salesSummaryEnabled: true },
    orderBy: { sortOrder: "asc" },
  });
  return channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    displayName: ch.displayName ?? ch.name,
    shortName: ch.shortName,
    sortOrder: ch.sortOrder,
    includeInOverallTotals: ch.includeInOverallTotals,
    sourceNames: JSON.parse(ch.sourceNamesJson) as string[],
    sourceNamesJson: ch.sourceNamesJson,
    sourceNamesSnapshot: ch.sourceNamesSnapshot,
  }));
}
