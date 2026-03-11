/**
 * Sales Summary Engine
 * 要件書 §21.6: 売上サマリー算出
 *
 * - Shopify注文データから日次KPIを算出
 * - 予算・入店数と組み合わせてキャッシュに保存
 */
import prisma from "../db.server";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DailySummaryRowDTO {
  locationId: string;
  locationName: string;
  targetDate: string;
  actual: number;
  orders: number;
  items: number;
  visitors: number | null;
  budget: number | null;
  budgetRatio: number | null;
  conv: number | null;      // 購買率 = orders / visitors
  atv: number | null;       // 客単価 = actual / orders
  setRate: number | null;   // セット率 = items / orders
  unit: number | null;      // 一品単価 = actual / items
  currency: string;
  footfallReportingEnabled?: boolean;
}

// ── Shopify Types ─────────────────────────────────────────────────────────────

interface SummaryOrder {
  id: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { edges: { node: { quantity: number } }[] };
  tags: string[];
}

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

// ── GraphQL Query（精算より軽量） ──────────────────────────────────────────────

const SUMMARY_ORDERS_QUERY = `#graphql
  query SalesSummaryOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        cursor
        node {
          id
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 250) {
            edges { node { quantity } }
          }
          tags
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ── Fetch All Orders（精算注文を除外） ─────────────────────────────────────────

async function fetchSummaryOrders(admin: AdminClient, query: string): Promise<SummaryOrder[]> {
  const orders: SummaryOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(SUMMARY_ORDERS_QUERY, {
      variables: { first: 100, after: cursor, query },
    });
    const json = await response.json() as {
      data?: {
        orders?: {
          edges?: { cursor: string; node: SummaryOrder }[];
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };

    const edges = json.data?.orders?.edges ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const edge of edges) {
      if (!edge.node.tags?.includes("settlement")) {
        orders.push(edge.node);
      }
    }

    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
  }

  return orders;
}

// ── メインエントリ ─────────────────────────────────────────────────────────────

export async function computeAndCacheDailySummary(
  admin: AdminClient,
  shopId: string,
  locationId: string,
  locationName: string,
  targetDate: string,
): Promise<DailySummaryRowDTO> {
  const locIdRaw = locationId.replace("gid://shopify/Location/", "");
  const locationGid = locationId.startsWith("gid://")
    ? locationId
    : `gid://shopify/Location/${locationId}`;

  // Shopify注文取得
  const shopifyQuery = `location_id:${locIdRaw} created_at:>=${targetDate}T00:00:00 created_at:<=${targetDate}T23:59:59`;
  const orders = await fetchSummaryOrders(admin, shopifyQuery);

  let actual = 0;
  let orderCount = 0;
  let itemCount = 0;
  let currency = "JPY";

  for (const order of orders) {
    actual += Number(order.totalPriceSet.shopMoney.amount);
    currency = order.totalPriceSet.shopMoney.currencyCode;
    orderCount += 1;
    itemCount += order.lineItems.edges.reduce((sum, e) => sum + e.node.quantity, 0);
  }

  // 予算取得（複数の ID 形式に対応）
  const budget = await prisma.budget.findFirst({
    where: {
      shopId,
      locationId: { in: [locationId, locationGid, locIdRaw] },
      targetDate,
    },
  });

  // 入店数取得
  const footfall = await prisma.footfallReport.findFirst({
    where: {
      shopId,
      locationId: { in: [locationId, locationGid, locIdRaw] },
      targetDate,
    },
  });

  const budgetAmount = budget ? Number(budget.amount) : null;
  const visitors = footfall?.visitors ?? null;

  // KPI 算出
  const budgetRatio = budgetAmount && budgetAmount > 0 ? actual / budgetAmount : null;
  const conv = visitors && visitors > 0 ? orderCount / visitors : null;
  const atv = orderCount > 0 ? actual / orderCount : null;
  const setRate = orderCount > 0 ? itemCount / orderCount : null;
  const unit = itemCount > 0 ? actual / itemCount : null;

  // キャッシュ更新
  await prisma.salesSummaryCacheDaily.upsert({
    where: {
      shopId_locationId_targetDate: { shopId, locationId: locationGid, targetDate },
    },
    update: { actual, orders: orderCount, items: itemCount, visitors, conv, atv, setRate, unit, budget: budgetAmount, budgetRatio },
    create: {
      shopId,
      locationId: locationGid,
      targetDate,
      actual,
      orders: orderCount,
      items: itemCount,
      visitors,
      conv,
      atv,
      setRate,
      unit,
      budget: budgetAmount,
      budgetRatio,
    },
  });

  return {
    locationId: locationGid,
    locationName,
    targetDate,
    actual,
    orders: orderCount,
    items: itemCount,
    visitors,
    budget: budgetAmount,
    budgetRatio,
    conv,
    atv,
    setRate,
    unit,
    currency,
  };
}
