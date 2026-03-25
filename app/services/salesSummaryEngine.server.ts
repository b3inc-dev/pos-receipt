/**
 * Sales Summary Engine
 * 要件書 §21.6: 売上サマリー算出
 *
 * - Shopify注文データから日次KPIを算出（ショップタイムゾーンで「その日」の境界を算出）
 * - その日の返金を反映し actual を純売上（粗利−返金）とする（GAS_vs_APP_IMPLEMENTATION_GAP §7.3）
 * - 予算・入店数と組み合わせてキャッシュに保存
 */
import prisma from "../db.server";
import { getShopTimezoneForDaily, getDayRangeInUtc } from "../utils/shopTimezone.server";
import { expandLocationIdsForBudgetQuery } from "../utils/salesSummaryBudgetFromDb.server";
import { buildSettlementPreview } from "./settlementEngine.server";

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

interface SummaryRefund {
  createdAt?: string;
  totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } };
  refundLineItems?: { quantity: number }[];
}

interface SummaryTransaction {
  id: string;
  createdAt?: string;
  kind: string;
  status: string;
  amountSet: { shopMoney: { amount: string; currencyCode: string } };
}

interface SummaryOrder {
  id: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { nodes: { quantity: number }[] };
  transactions: SummaryTransaction[];
  refunds: SummaryRefund[];
  tags: string[];
  retailLocation?: { id: string } | null;
}

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

// ── GraphQL Query（精算より軽量） ──────────────────────────────────────────────

const SUMMARY_ORDERS_QUERY = `#graphql
  query SalesSummaryOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      nodes {
        id
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 250) {
          nodes { quantity }
        }
        transactions(first: 50) {
          id
          createdAt
          kind
          status
          amountSet { shopMoney { amount currencyCode } }
        }
        refunds {
          createdAt
          refundLineItems(first: 250) {
            nodes { quantity }
          }
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
        tags
        retailLocation { id }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function extractLocationNumericId(locationId: string | null | undefined): string | null {
  if (!locationId) return null;
  const s = String(locationId).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ?? null;
}

/** 精算エンジンと同じく、検索で location_id 済みなら retailLocation が null でも含める */
function filterSummaryOrdersByRetailLocation(
  orders: SummaryOrder[],
  locationId: string,
  locIdRaw: string
): SummaryOrder[] {
  const locationGid = locationId.startsWith("gid://") ? locationId : `gid://shopify/Location/${locIdRaw}`;
  return orders.filter((o) => {
    const rid = o.retailLocation?.id;
    if (!rid) return true;
    const ridRaw = extractLocationNumericId(rid);
    return rid === locationGid || ridRaw === locIdRaw;
  });
}

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
          nodes?: SummaryOrder[];
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const node of nodes as Array<SummaryOrder & {
      refunds?: Array<SummaryRefund & { refundLineItems?: { nodes?: { quantity: number }[] } | { quantity: number }[] }>;
    }>) {
      // タグ表記ゆれ（SETTLEMENT / settlement）に備えて大文字小文字無視で精算注文を除外
      const isSettlement = (node.tags ?? []).some((t) => String(t).toLowerCase() === "settlement");
      if (!isSettlement) {
        orders.push({
          ...node,
          transactions: node.transactions ?? [],
          refunds: (node.refunds ?? []).map((r) => {
            const rawRefundLineItems = r.refundLineItems as unknown;
            const normalizedRefundLineItems: { quantity: number }[] = Array.isArray(rawRefundLineItems)
              ? rawRefundLineItems as { quantity: number }[]
              : (
                rawRefundLineItems &&
                typeof rawRefundLineItems === "object" &&
                "nodes" in rawRefundLineItems
              )
                ? ((rawRefundLineItems as { nodes?: { quantity: number }[] }).nodes ?? [])
                : [];
            return {
              ...r,
              refundLineItems: normalizedRefundLineItems,
            };
          }),
        });
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
  if (!locIdRaw || !/^\d+$/.test(locIdRaw)) {
    throw new Error(`Invalid locationId: "${locationId}"`);
  }
  const locationGid = locationId.startsWith("gid://")
    ? locationId
    : `gid://shopify/Location/${locationId}`;

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dayRange = getDayRangeInUtc(targetDate, timezone);

  // 売上サマリーの基礎数値は精算プレビューと同じ集計関数を使用し、差分をゼロにする
  const preview = await buildSettlementPreview(
    admin,
    shopId,
    locationId,
    locationName,
    targetDate
  );
  const actual = Number(preview.netSales);
  const orderCount = Number(preview.orderCount);
  const itemCount = Number(preview.itemCount);
  const currency = preview.currency || "JPY";

  const idVariants = expandLocationIdsForBudgetQuery(locationGid);

  // 予算取得（複数の ID 形式に対応）
  const budget = await prisma.budget.findFirst({
    where: {
      shopId,
      locationId: { in: idVariants },
      targetDate,
    },
  });

  // 入店数取得
  const footfall = await prisma.footfallReport.findFirst({
    where: {
      shopId,
      locationId: { in: idVariants },
      targetDate,
    },
  });

  const budgetAmount = budget ? Number(budget.amount) : null;
  const visitors = footfall?.visitors ?? null;

  // KPI 算出（actual = 純売上 = 粗利 - その日の返金）
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
