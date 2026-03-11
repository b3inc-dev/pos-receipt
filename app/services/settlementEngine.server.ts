/**
 * Settlement Engine
 * 要件書 §6: 精算エンジン
 *
 * - Shopify注文データから日次売上を集計
 * - 支払方法別内訳（payment sections）を算出
 * - 特殊返金・商品券調整イベントを反映
 * - 支払方法マスタ・ポイント/会員施策設定を参照
 */
import prisma from "../db.server";
import { getPaymentMethodDisplayLabel } from "../utils/paymentMethod.server";
import { getAppSetting } from "../utils/appSettings.server";
import { LOYALTY_SETTINGS_KEY, DEFAULT_LOYALTY_SETTINGS } from "../utils/appSettings.server";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PaymentSectionDTO {
  gateway: string;
  label: string;
  net: number;        // 売上合計
  refund: number;     // 返金合計
  txCount: number;
  refundCount: number;
}

export interface SettlementPreviewDTO {
  locationId: string;
  locationName: string;
  targetDate: string;
  currency: string;
  total: number;
  netSales: number;
  tax: number;
  discounts: number;
  vipPointsUsed: number;
  refundTotal: number;
  orderCount: number;
  refundCount: number;
  itemCount: number;
  voucherChangeAmount: number;
  paymentSections: PaymentSectionDTO[];
  appliedSpecialRefundEvents: {
    id: string;
    eventType: string;
    amount: number;
    sourceOrderName: string | null;
  }[];
  appliedVoucherAdjustments: {
    id: string;
    voucherChangeAmount: number;
    sourceOrderName: string | null;
  }[];
  /** ポイント利用額の表示ラベル（設定から取得） */
  loyaltyUsageDisplayLabel: string;
}

// ── Gateway Labels（支払方法マスタ未設定時はフォールバックを paymentMethod.server で使用） ───

// ── Shopify Types ─────────────────────────────────────────────────────────────

interface ShopifyTransaction {
  id: string;
  kind: string;
  status: string;
  amountSet: { shopMoney: { amount: string; currencyCode: string } };
  gateway: string;
}

interface ShopifyRefundTransaction {
  id: string;
  kind: string;
  gateway: string;
  amountSet: { shopMoney: { amount: string; currencyCode: string } };
}

interface ShopifyRefund {
  id: string;
  totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } };
  transactions: ShopifyRefundTransaction[];
}

interface ShopifyOrder {
  id: string;
  name: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalTaxSet: { shopMoney: { amount: string } };
  totalDiscountsSet: { shopMoney: { amount: string } };
  lineItems: { edges: { node: { quantity: number } }[] };
  transactions: ShopifyTransaction[];
  refunds: ShopifyRefund[];
  tags: string[];
}

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

// ── GraphQL Query ─────────────────────────────────────────────────────────────

const SETTLEMENT_ORDERS_QUERY = `#graphql
  query SettlementOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        cursor
        node {
          id
          name
          totalPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount } }
          totalDiscountsSet { shopMoney { amount } }
          lineItems(first: 250) {
            edges { node { quantity } }
          }
          transactions {
            id
            kind
            status
            amountSet { shopMoney { amount currencyCode } }
            gateway
          }
          refunds {
            id
            totalRefundedSet { shopMoney { amount currencyCode } }
            transactions {
              id
              kind
              gateway
              amountSet { shopMoney { amount currencyCode } }
            }
          }
          tags
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ── Fetch All Orders（精算注文を除外しながら全ページ取得） ────────────────────

async function fetchAllOrders(admin: AdminClient, query: string): Promise<ShopifyOrder[]> {
  const orders: ShopifyOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(SETTLEMENT_ORDERS_QUERY, {
      variables: { first: 100, after: cursor, query },
    });
    const json = await response.json() as {
      data?: {
        orders?: {
          edges?: { cursor: string; node: ShopifyOrder }[];
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };

    const edges = json.data?.orders?.edges ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const edge of edges) {
      // タグ "settlement" の精算注文は集計から除外
      if (!edge.node.tags?.includes("settlement")) {
        orders.push(edge.node);
      }
    }

    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
  }

  return orders;
}

// ── Payment Sections 算出（支払方法マスタで表示名を解決） ────────────────────────

async function calculatePaymentSections(
  orders: ShopifyOrder[],
  shopId: string
): Promise<PaymentSectionDTO[]> {
  const sections: Record<string, { net: number; refund: number; txCount: number; refundCount: number }> = {};

  const ensure = (gateway: string) => {
    if (!sections[gateway]) {
      sections[gateway] = { net: 0, refund: 0, txCount: 0, refundCount: 0 };
    }
  };

  for (const order of orders) {
    for (const tx of order.transactions) {
      if ((tx.kind === "SALE" || tx.kind === "CAPTURE") && tx.status === "SUCCESS") {
        const gw = tx.gateway ?? "";
        ensure(gw);
        sections[gw].net += Number(tx.amountSet.shopMoney.amount);
        sections[gw].txCount += 1;
      }
    }
    for (const refund of order.refunds) {
      for (const tx of refund.transactions) {
        if (tx.kind === "REFUND") {
          const gw = tx.gateway ?? "";
          ensure(gw);
          sections[gw].refund += Number(tx.amountSet.shopMoney.amount);
          sections[gw].refundCount += 1;
        }
      }
    }
  }

  const result: PaymentSectionDTO[] = [];
  for (const [gateway, data] of Object.entries(sections)) {
    const label = await getPaymentMethodDisplayLabel(shopId, gateway);
    result.push({ gateway, label, ...data });
  }
  return result;
}

// ── メインエントリ ─────────────────────────────────────────────────────────────

export async function buildSettlementPreview(
  admin: AdminClient,
  shopId: string,
  locationId: string,
  locationName: string,
  targetDate: string,
): Promise<SettlementPreviewDTO> {
  // Shopify location ID を数値部のみに正規化（クエリ用）
  const locIdRaw = locationId.replace("gid://shopify/Location/", "");

  // Shopify GraphQL クエリ（Shopify 側でショップのタイムゾーンを適用）
  const shopifyQuery = `location_id:${locIdRaw} created_at:>=${targetDate}T00:00:00 created_at:<=${targetDate}T23:59:59`;
  const orders = await fetchAllOrders(admin, shopifyQuery);

  let total = 0;
  let tax = 0;
  let discounts = 0;
  let refundTotal = 0;
  let itemCount = 0;
  let refundCount = 0;
  const currency = orders[0]?.totalPriceSet?.shopMoney?.currencyCode ?? "JPY";

  for (const order of orders) {
    total += Number(order.totalPriceSet.shopMoney.amount);
    tax += Number(order.totalTaxSet.shopMoney.amount);
    discounts += Number(order.totalDiscountsSet.shopMoney.amount);
    itemCount += order.lineItems.edges.reduce((sum, e) => sum + e.node.quantity, 0);
    for (const refund of order.refunds) {
      refundTotal += Number(refund.totalRefundedSet.shopMoney.amount);
      refundCount += 1;
    }
  }

  const netSales = total - discounts;

  // 特殊返金・商品券調整イベントを取得（複数の ID 形式に対応）
  const locationGid = locationId.startsWith("gid://") ? locationId : `gid://shopify/Location/${locationId}`;
  const specialRefundEvents = await prisma.specialRefundEvent.findMany({
    where: {
      shopId,
      locationId: { in: [locationId, locationGid, locIdRaw] },
      status: "active",
      createdAt: {
        gte: new Date(`${targetDate}T00:00:00.000Z`),
        lte: new Date(`${targetDate}T23:59:59.999Z`),
      },
    },
  });

  const voucherAdjustments = specialRefundEvents.filter(
    (e) => e.eventType === "voucher_change_adjustment"
  );
  const otherEvents = specialRefundEvents.filter(
    (e) => e.eventType !== "voucher_change_adjustment"
  );

  const voucherChangeAmount = voucherAdjustments.reduce(
    (sum, e) => sum + Number(e.voucherChangeAmount ?? 0),
    0
  );
  const vipPointsUsed = otherEvents
    .filter((e) => e.originalPaymentMethod === "points")
    .reduce((sum, e) => sum + Number(e.amount), 0);

  const loyaltySettings = await getAppSetting<{ loyaltyUsageDisplayLabel?: string }>(shopId, LOYALTY_SETTINGS_KEY);
  const loyaltyUsageDisplayLabel =
    loyaltySettings?.loyaltyUsageDisplayLabel ?? DEFAULT_LOYALTY_SETTINGS.loyaltyUsageDisplayLabel;

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    locationId,
    locationName,
    targetDate,
    currency,
    total: round2(total),
    netSales: round2(netSales),
    tax: round2(tax),
    discounts: round2(discounts),
    vipPointsUsed: round2(vipPointsUsed),
    refundTotal: round2(refundTotal),
    orderCount: orders.length,
    refundCount,
    itemCount,
    voucherChangeAmount: round2(voucherChangeAmount),
    paymentSections: await calculatePaymentSections(orders, shopId),
    appliedSpecialRefundEvents: otherEvents.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      amount: Number(e.amount),
      sourceOrderName: e.sourceOrderName,
    })),
    appliedVoucherAdjustments: voucherAdjustments.map((e) => ({
      id: e.id,
      voucherChangeAmount: Number(e.voucherChangeAmount ?? 0),
      sourceOrderName: e.sourceOrderName,
    })),
    loyaltyUsageDisplayLabel,
  };
}
