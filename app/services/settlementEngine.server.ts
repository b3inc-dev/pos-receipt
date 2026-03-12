/**
 * Settlement Engine
 * 要件書 §6: 精算エンジン
 *
 * - Shopify注文データから日次売上を集計（ショップタイムゾーンで「その日」の境界を算出）
 * - 支払方法別内訳（payment sections）を算出
 * - 特殊返金・商品券調整イベントを合計・payment sections に反映
 * - 支払方法マスタ・ポイント/会員施策設定を参照
 */
import prisma from "../db.server";
import { getPaymentMethodDisplayLabel } from "../utils/paymentMethod.server";
import { getAppSetting } from "../utils/appSettings.server";
import { LOYALTY_SETTINGS_KEY, DEFAULT_LOYALTY_SETTINGS } from "../utils/appSettings.server";
import { getShopTimezoneForDaily, getDayRangeInUtc } from "../utils/shopTimezone.server";

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
  createdAt?: string; // ISO (UTC); 返金日でフィルタするため
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
            createdAt
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

/** 返金再集計用: updated_at でその日に更新された注文を取得（refunds.createdAt でフィルタするため） */
const REFUNDS_ORDERS_QUERY = `#graphql
  query RefundsOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        cursor
        node {
          id
          tags
          refunds {
            id
            createdAt
            totalRefundedSet { shopMoney { amount currencyCode } }
            transactions {
              id
              kind
              gateway
              amountSet { shopMoney { amount currencyCode } }
            }
          }
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
      if (!edge.node.tags?.includes("settlement")) {
        orders.push(edge.node);
      }
    }

    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
  }

  return orders;
}

/** 返金再集計用: その日に updated された注文を取得（refunds に createdAt 含む） */
interface OrderWithRefundsCreatedAt {
  id: string;
  tags: string[];
  refunds: ShopifyRefund[];
}

async function fetchOrdersUpdatedInDayRange(
  admin: AdminClient,
  query: string
): Promise<OrderWithRefundsCreatedAt[]> {
  const orders: OrderWithRefundsCreatedAt[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(REFUNDS_ORDERS_QUERY, {
      variables: { first: 100, after: cursor, query },
    });
    const json = await response.json() as {
      data?: {
        orders?: {
          edges?: { cursor: string; node: OrderWithRefundsCreatedAt }[];
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

/**
 * その日に処理された返金のみを集計（別パス）。
 * 注文の created_at がその日でない場合の返金を拾う（GAS computeRefundsOnlyForDay 相当）。
 * @param ordersUpdated その日 updated_at で取得した注文（refunds[].createdAt 必須）
 * @param orderIdsCreatedInDay その日 created_at で取得した注文 ID（二重計上を避けるため除外）
 * @param dayRange その日の UTC 範囲（refund.createdAt のフィルタ用）
 */
function computeRefundsOnlyForDay(
  ordersUpdated: OrderWithRefundsCreatedAt[],
  orderIdsCreatedInDay: Set<string>,
  dayRange: { startUtc: Date; endUtc: Date }
): { refundTotal: number; refundCount: number; byGateway: Record<string, { refund: number; refundCount: number }> } {
  const byGateway: Record<string, { refund: number; refundCount: number }> = {};
  const ensure = (gw: string) => {
    if (!byGateway[gw]) byGateway[gw] = { refund: 0, refundCount: 0 };
  };

  let refundTotal = 0;
  let refundCount = 0;

  for (const order of ordersUpdated) {
    if (orderIdsCreatedInDay.has(order.id)) continue;

    for (const refund of order.refunds) {
      const createdAt = refund.createdAt ? new Date(refund.createdAt).getTime() : 0;
      if (createdAt < dayRange.startUtc.getTime() || createdAt > dayRange.endUtc.getTime()) continue;

      refundTotal += Number(refund.totalRefundedSet?.shopMoney?.amount ?? 0);
      refundCount += 1;

      for (const tx of refund.transactions ?? []) {
        if (tx.kind !== "REFUND") continue;
        const gw = tx.gateway ?? "";
        ensure(gw);
        byGateway[gw].refund += Number(tx.amountSet?.shopMoney?.amount ?? 0);
        byGateway[gw].refundCount += 1;
      }
    }
  }

  return { refundTotal, refundCount, byGateway };
}

/**
 * その日の返金オーバーレイ（注文が「その日作成」でない分）の refundTotal を返す。
 * 売上サマリーの actual（純売上）算出で利用（GAS_vs_APP_IMPLEMENTATION_GAP §7.3）。
 */
export async function getRefundOverlayForDay(
  admin: AdminClient,
  locIdRaw: string,
  orderIdsCreatedInDay: Set<string>,
  dayRange: { startUtc: Date; endUtc: Date }
): Promise<{ refundTotal: number }> {
  const startIso = dayRange.startUtc.toISOString().replace(/\.000Z$/, "Z");
  const endIso = dayRange.endUtc.toISOString();
  const updatedQuery = `location_id:${locIdRaw} updated_at:>=${startIso} updated_at:<=${endIso}`;
  const ordersUpdated = await fetchOrdersUpdatedInDayRange(admin, updatedQuery);
  const overlay = computeRefundsOnlyForDay(ordersUpdated, orderIdsCreatedInDay, dayRange);
  return { refundTotal: overlay.refundTotal };
}

/** 返金オーバーレイを payment sections と合計にマージ */
function mergeRefundOverlay(
  sections: PaymentSectionDTO[],
  overlay: { refundTotal: number; refundCount: number; byGateway: Record<string, { refund: number; refundCount: number }> },
  totals: { refundTotal: number; refundCount: number }
): void {
  totals.refundTotal += overlay.refundTotal;
  totals.refundCount += overlay.refundCount;
  for (const [gateway, data] of Object.entries(overlay.byGateway)) {
    const idx = sections.findIndex((s) => s.gateway === gateway);
    if (idx >= 0) {
      sections[idx].refund += data.refund;
      sections[idx].refundCount += data.refundCount;
    } else {
      sections.push({
        gateway,
        label: gateway,
        net: 0,
        refund: data.refund,
        txCount: 0,
        refundCount: data.refundCount,
      });
    }
  }
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

/** payment sections から gateway または label で該当セクションのインデックスを返す */
function findSectionIndex(sections: PaymentSectionDTO[], gatewayOrLabel: string | null): number {
  if (!gatewayOrLabel) return -1;
  const s = String(gatewayOrLabel).trim().toLowerCase();
  const i = sections.findIndex(
    (sec) => sec.gateway.toLowerCase() === s || sec.label.toLowerCase() === s
  );
  if (i >= 0) return i;
  // 現金系の表記ゆれ
  if (["現金", "cash"].some((k) => s.includes(k) || k.includes(s))) {
    return sections.findIndex((sec) => sec.gateway.toLowerCase() === "cash" || sec.label === "現金");
  }
  return -1;
}

/** 特殊返金イベントを total / refundTotal / paymentSections に反映（GAS overlay 相当） */
function applySpecialRefundEventsToTotals(
  sections: PaymentSectionDTO[],
  otherEvents: { eventType: string; amount: { toString(): string }; originalPaymentMethod: string | null; actualRefundMethod: string | null; adjustKind: string | null }[],
  totals: { total: number; refundTotal: number }
): void {
  for (const e of otherEvents) {
    const amount = Number(e.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    switch (e.eventType) {
      case "cash_refund": {
        totals.refundTotal += amount;
        const idx = findSectionIndex(sections, e.actualRefundMethod ?? "cash");
        if (idx >= 0) sections[idx].refund += amount;
        else if (sections.length > 0) sections[0].refund += amount;
        break;
      }
      case "receipt_cash_adjustment": {
        const kind = (e.adjustKind ?? "undo").toLowerCase();
        const method = e.originalPaymentMethod ?? e.actualRefundMethod ?? "cash";
        const idx = findSectionIndex(sections, method);
        if (kind === "undo") {
          totals.refundTotal -= amount;
          if (idx >= 0) sections[idx].refund = Math.max(0, sections[idx].refund - amount);
        } else {
          totals.total += amount;
          if (idx >= 0) sections[idx].net += amount;
        }
        break;
      }
      case "payment_method_override": {
        totals.refundTotal += amount;
        const idx = findSectionIndex(sections, e.actualRefundMethod ?? "cash");
        if (idx >= 0) sections[idx].refund += amount;
        break;
      }
      default:
        break;
    }
  }
}

// ── メインエントリ ─────────────────────────────────────────────────────────────

export async function buildSettlementPreview(
  admin: AdminClient,
  shopId: string,
  locationId: string,
  locationName: string,
  targetDate: string,
): Promise<SettlementPreviewDTO> {
  const locIdRaw = locationId.replace("gid://shopify/Location/", "");

  // ショップタイムゾーンで「その日」の UTC 範囲を算出（GAS_vs_APP_IMPLEMENTATION_GAP §5）
  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dayRange = getDayRangeInUtc(targetDate, timezone);

  const shopifyQuery = `location_id:${locIdRaw} created_at:>=${dayRange.startUtcIso} created_at:<=${dayRange.endUtcIso}`;
  const orders = await fetchAllOrders(admin, shopifyQuery);

  const orderIdsCreatedInDay = new Set(orders.map((o) => o.id));

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

  // 返金再集計（別パス）: その日に処理された返金のうち、注文が「その日作成」でない分を追加（GAS overlayRefundsAndRecalc 相当）
  const updatedQuery = `location_id:${locIdRaw} updated_at:>=${dayRange.startUtcIso} updated_at:<=${dayRange.endUtcIso}`;
  const ordersUpdated = await fetchOrdersUpdatedInDayRange(admin, updatedQuery);
  const overlay = computeRefundsOnlyForDay(ordersUpdated, orderIdsCreatedInDay, dayRange);

  let netSales = total - discounts;

  const locationGid = locationId.startsWith("gid://") ? locationId : `gid://shopify/Location/${locationId}`;
  const specialRefundEvents = await prisma.specialRefundEvent.findMany({
    where: {
      shopId,
      locationId: { in: [locationId, locationGid, locIdRaw] },
      status: "active",
      createdAt: {
        gte: dayRange.startUtc,
        lte: dayRange.endUtc,
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

  let paymentSections = await calculatePaymentSections(orders, shopId);
  mergeRefundOverlay(paymentSections, overlay, { refundTotal, refundCount });
  applySpecialRefundEventsToTotals(paymentSections, otherEvents, { total, refundTotal });

  // 税・net の再計算（GAS_vs_APP_IMPLEMENTATION_GAP §7.2: 返金反映後の税込額から税・純売上を算出）
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const effectiveGross = Math.max(0, total - refundTotal - discounts);
  tax = round2(effectiveGross * 10 / 110);
  netSales = round2((total - refundTotal - discounts) - tax);

  for (const sec of paymentSections) {
    if (sec.label === sec.gateway) {
      sec.label = await getPaymentMethodDisplayLabel(shopId, sec.gateway);
    }
  }

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
    paymentSections,
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
