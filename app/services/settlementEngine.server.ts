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
import { LOYALTY_SETTINGS_KEY, DEFAULT_LOYALTY_SETTINGS, SETTLEMENT_SETTINGS_KEY } from "../utils/appSettings.server";
import { getShopTimezoneForDaily, getDayRangeInUtc, getDayRangeShopifySearchIso } from "../utils/shopTimezone.server";

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
  /**
   * recompute 時の原因切り分け用デバッグ情報。
   * 通常時は入れない（重くなるため）。
   */
  debug?: SettlementPreviewDebugDTO;
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

export interface SettlementPreviewDebugDTO {
  // Shopify 検索結果（売上集計用）の件数
  ordersRawCount: number;
  // sourceName で POS 相当だけ残した件数
  ordersPosSourceMatchedCount: number;
  // retailLocation（または null の許容）で対象ロケーションとして残った件数
  ordersAtLocationCount: number;

  // 返金オーバーレイ用（updated_at ベース）件数
  ordersUpdatedRawCount: number;
  ordersUpdatedPosSourceMatchedCount: number;
  ordersUpdatedAtLocationCount: number;
  overlayRefundCount: number;
}

// ── Gateway Labels（支払方法マスタ未設定時はフォールバックを paymentMethod.server で使用） ───

// ── Shopify Types ─────────────────────────────────────────────────────────────

interface ShopifyTransaction {
  id: string;
  createdAt?: string;
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
  refundLineItems?: { quantity: number }[];
  transactions: ShopifyRefundTransaction[];
}

interface ShopifyOrder {
  id: string;
  name: string;
  sourceName?: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalTaxSet: { shopMoney: { amount: string } };
  totalDiscountsSet: { shopMoney: { amount: string } };
  lineItems: { nodes: { quantity: number }[] };
  transactions: ShopifyTransaction[];
  refunds: ShopifyRefund[];
  tags: string[];
  retailLocation?: { id: string } | null;
}

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

// ── GraphQL Query ─────────────────────────────────────────────────────────────

const SETTLEMENT_ORDERS_QUERY = `#graphql
  query SettlementOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      nodes {
        id
        name
        sourceName
        totalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        lineItems(first: 250) {
          nodes { quantity }
        }
        transactions(first: 50) {
          id
          createdAt
          kind
          status
          amountSet { shopMoney { amount currencyCode } }
          gateway
        }
        refunds {
          id
          createdAt
          refundLineItems(first: 250) {
            nodes { quantity }
          }
          totalRefundedSet { shopMoney { amount currencyCode } }
          transactions(first: 50) {
            nodes {
              id
              kind
              gateway
              amountSet { shopMoney { amount currencyCode } }
            }
          }
        }
        tags
        retailLocation { id }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** GID または数値ロケーション ID から数値部分を取り出す */
function extractLocationNumericId(locationId: string | null | undefined): string | null {
  if (!locationId) return null;
  const s = String(locationId).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ?? null;
}

/**
 * 注文を対象ロケーションに絞る。
 * Admin の orders 検索で既に location_id:（数値）を付けているため、retailLocation が GraphQL で null の POS 注文も拾う（さもないと売上・件数が大きく欠ける）。
 * retailLocation があるときだけ厳密照合し、別店舗なら除外する。
 */
function filterOrdersByRetailLocation(
  orders: ShopifyOrder[],
  locationId: string,
  locIdRaw: string
): ShopifyOrder[] {
  const locationGid = locationId.startsWith("gid://") ? locationId : `gid://shopify/Location/${locIdRaw}`;
  return orders.filter((o) => {
    const rid = o.retailLocation?.id;
    if (!rid) return true;
    const ridRaw = extractLocationNumericId(rid);
    return rid === locationGid || ridRaw === locIdRaw;
  });
}

/**
 * Shopify の注文は店舗・API 世代で sourceName が異なる（pos / point_of_sale / shopify_pos 等）。
 * 検索を source_name:pos のみにすると取りこぼすため、広く取得したあとここで POS のみ残す。
 */
function isPosOrderSourceName(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return false;
  if (s === "pos" || s === "shopify_pos" || s === "point_of_sale") return true;
  if (s.includes("point_of_sale") || s.includes("point of sale")) return true;
  if (s.includes("shopify_pos") || s === "shopifypossdk") return true;
  return false;
}

function filterOrdersToPosSalesBySourceName(orders: ShopifyOrder[]): ShopifyOrder[] {
  return orders.filter((o) => isPosOrderSourceName(o.sourceName));
}

/** 返金再集計用: updated_at でその日に更新された注文を取得（refunds.createdAt でフィルタするため） */
const REFUNDS_ORDERS_QUERY = `#graphql
  query RefundsOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes {
        id
        sourceName
        tags
        retailLocation { id }
        refunds {
          id
          createdAt
          totalRefundedSet { shopMoney { amount currencyCode } }
          transactions(first: 50) {
            nodes {
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
          nodes?: (ShopifyOrder & {
            refunds?: (Omit<ShopifyRefund, "transactions"> & { transactions?: { nodes?: ShopifyRefundTransaction[] } })[];
          })[];
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const node of nodes) {
      // クエリで -tag:SETTLEMENT 済みだが、タグ表記ゆれ（SETTLEMENT / settlement）に備えて大文字小文字無視で除外
      const isSettlement = (node.tags ?? []).some((t) => String(t).toLowerCase() === "settlement");
      if (!isSettlement) {
        const order: ShopifyOrder = {
          ...node,
          transactions: node.transactions ?? [],
          refunds: (node.refunds ?? []).map((r) => ({
            ...r,
            refundLineItems: r.refundLineItems?.nodes ?? [],
            transactions: r.transactions?.nodes ?? [],
          })),
        };
        orders.push(order);
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
  sourceName?: string | null;
  tags: string[];
  refunds: ShopifyRefund[];
  retailLocation?: { id: string } | null;
}

/** 返金用注文を retailLocation が指定ロケーションと一致するもののみに絞る */
function filterOrdersUpdatedByRetailLocation(
  orders: OrderWithRefundsCreatedAt[],
  locationId: string,
  locIdRaw: string
): OrderWithRefundsCreatedAt[] {
  const locationGid = locationId.startsWith("gid://") ? locationId : `gid://shopify/Location/${locIdRaw}`;
  return orders.filter((o) => {
    const rid = o.retailLocation?.id;
    if (!rid) return true;
    const ridRaw = extractLocationNumericId(rid);
    return rid === locationGid || ridRaw === locIdRaw;
  });
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
          nodes?: (OrderWithRefundsCreatedAt & {
            refunds?: (Omit<ShopifyRefund, "transactions"> & { transactions?: { nodes?: ShopifyRefundTransaction[] } })[];
          })[];
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
          id: node.id,
          sourceName: (node as { sourceName?: string | null }).sourceName ?? null,
          tags: node.tags,
          retailLocation: (node as OrderWithRefundsCreatedAt).retailLocation,
          refunds: (node.refunds ?? []).map((r) => ({
            ...r,
            transactions: r.transactions?.nodes ?? [],
          })),
        });
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
  const locationGid = `gid://shopify/Location/${locIdRaw}`;
  // GAS と同様に updated_at ベースの返金補足では cancelled も含める（POS は sourceName で事後フィルタ）
  const updatedQuery = `location_id:${locIdRaw} updated_at:>=${startIso} updated_at:<=${endIso} tag_not:settlement`;
  const ordersUpdatedRaw = await fetchOrdersUpdatedInDayRange(admin, updatedQuery);
  const ordersUpdated = ordersUpdatedRaw.filter((o) => isPosOrderSourceName(o.sourceName));
  const ordersUpdatedAtLocation = filterOrdersUpdatedByRetailLocation(ordersUpdated, locationGid, locIdRaw);
  const overlay = computeRefundsOnlyForDay(ordersUpdatedAtLocation, orderIdsCreatedInDay, dayRange);
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
  shopId: string,
  dayRange: { startUtc: Date; endUtc: Date }
): Promise<PaymentSectionDTO[]> {
  const sections: Record<string, { net: number; refund: number; txCount: number; refundCount: number }> = {};
  const inDay = (iso?: string) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime();
  };

  const ensure = (gateway: string) => {
    if (!sections[gateway]) {
      sections[gateway] = { net: 0, refund: 0, txCount: 0, refundCount: 0 };
    }
  };

  for (const order of orders) {
    for (const tx of order.transactions) {
      // GAS と揃えるため tx.status を見ない
      if ((tx.kind === "SALE" || tx.kind === "CAPTURE") && inDay(tx.createdAt)) {
        const gw = tx.gateway ?? "";
        ensure(gw);
        sections[gw].net += Number(tx.amountSet.shopMoney.amount);
        sections[gw].txCount += 1;
      }
    }
    for (const refund of order.refunds) {
      if (!inDay(refund.createdAt)) continue;
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

/**
 * 税込の合計金額から税抜純売上と内税相当額を算出する。
 * buildSettlementPreview の netSales / tax と同一の式（精算設定の税率％を税込ベースから逆算）。
 * チャネル別売上など、注文 totalPriceSet ベースの税込実績を POS と同じ税抜に揃えるときに利用する。
 */
export function splitTaxInclusiveToNetAndTax(
  inclusiveTotal: number,
  taxRatePercent: number,
): { netSales: number; tax: number } {
  const roundInt = (n: number) => Math.round(n);
  const total = Math.max(0, inclusiveTotal);
  const tax = roundInt((total * taxRatePercent) / (100 + taxRatePercent));
  const netSales = roundInt(total - tax);
  return { netSales, tax };
}

// ── メインエントリ ─────────────────────────────────────────────────────────────

export async function buildSettlementPreview(
  admin: AdminClient,
  shopId: string,
  locationId: string,
  locationName: string,
  targetDate: string,
  opts?: { debug?: boolean },
): Promise<SettlementPreviewDTO> {
  const debugEnabled = opts?.debug === true;
  const locIdRaw = locationId.replace("gid://shopify/Location/", "");
  if (!locIdRaw || !/^\d+$/.test(locIdRaw)) {
    throw new Error(`Invalid locationId: "${locationId}"`);
  }

  // ショップタイムゾーンで「その日」の UTC 範囲を算出（GAS_vs_APP_IMPLEMENTATION_GAP §5）
  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dayRange = getDayRangeInUtc(targetDate, timezone);
  const searchIso = getDayRangeShopifySearchIso(targetDate, timezone);

  // 精算注文・キャンセル除外。source_name は店舗で表記が異なるため検索に含めず、取得後に sourceName で POS のみ残す
  const shopifyQuery = `location_id:${locIdRaw} created_at:>=${searchIso.start} created_at:<=${searchIso.end} tag_not:settlement -status:cancelled`;
  const ordersRaw = await fetchAllOrders(admin, shopifyQuery);
  const orders = filterOrdersToPosSalesBySourceName(ordersRaw);
  const ordersAtLocation = filterOrdersByRetailLocation(orders, locationId, locIdRaw);
  const ordersRawCount = ordersRaw.length;
  const ordersPosSourceMatchedCount = orders.length;
  const ordersAtLocationCount = ordersAtLocation.length;

  const orderIdsCreatedInDay = new Set(ordersAtLocation.map((o) => o.id));

  const inDay = (iso?: string) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime();
  };

  let total = 0;
  let tax = 0;
  let discounts = 0;
  let refundTotal = 0;
  let itemCount = 0;
  let refundCount = 0;
  const saleOrderSet = new Set<string>();
  const refundOrderSet = new Set<string>();
  const currency = ordersAtLocation[0]?.totalPriceSet?.shopMoney?.currencyCode ?? "JPY";

  for (const order of ordersAtLocation) {
    let orderSaleToday = 0;
    let orderRefundToday = 0;
    for (const tx of order.transactions) {
      if (!inDay(tx.createdAt)) continue;
      // GAS_精算レシート.md は transactions.kind だけで集計しており、tx.status === "SUCCESS" の条件がない。
      // その差で App 側だけ売上・件数が少なくなる可能性があるため、status 条件を外して GAS と揃える。
      if (tx.kind === "SALE" || tx.kind === "CAPTURE") {
        orderSaleToday += Number(tx.amountSet.shopMoney.amount);
      }
      if (tx.kind === "REFUND") {
        orderRefundToday += Number(tx.amountSet.shopMoney.amount);
      }
    }

    total += orderSaleToday;
    tax += Number(order.totalTaxSet.shopMoney.amount);
    discounts += Number(order.totalDiscountsSet.shopMoney.amount);

    if ((orderSaleToday - orderRefundToday) > 0) {
      saleOrderSet.add(order.id);
    }
    if (orderRefundToday > 0) {
      refundOrderSet.add(order.id);
    }

    if (orderSaleToday > 0) {
      itemCount += order.lineItems.nodes.reduce((sum, n) => sum + n.quantity, 0);
    }

    for (const refund of order.refunds) {
      if (!inDay(refund.createdAt)) continue;
      refundTotal += Number(refund.totalRefundedSet.shopMoney.amount);
      refundCount += 1;
      for (const ri of refund.refundLineItems ?? []) {
        itemCount -= Number(ri.quantity ?? 0);
      }
    }
  }

  // 返金再集計（別パス）: その日に処理された返金のうち、注文が「その日作成」でない分を追加（GAS overlayRefundsAndRecalc 相当）
  // GAS と同様に updated_at ベースの返金補足では cancelled も含める
  const updatedQuery = `location_id:${locIdRaw} updated_at:>=${searchIso.start} updated_at:<=${searchIso.end} tag_not:settlement`;
  const ordersUpdatedRaw = await fetchOrdersUpdatedInDayRange(admin, updatedQuery);
  const ordersUpdated = ordersUpdatedRaw.filter((o) => isPosOrderSourceName(o.sourceName));
  const ordersUpdatedAtLocation = filterOrdersUpdatedByRetailLocation(ordersUpdated, locationId, locIdRaw);
  const overlay = computeRefundsOnlyForDay(ordersUpdatedAtLocation, orderIdsCreatedInDay, dayRange);
  const ordersUpdatedRawCount = ordersUpdatedRaw.length;
  const ordersUpdatedPosSourceMatchedCount = ordersUpdated.length;
  const ordersUpdatedAtLocationCount = ordersUpdatedAtLocation.length;
  const overlayRefundCount = overlay.refundCount;

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

  let paymentSections = await calculatePaymentSections(ordersAtLocation, shopId, dayRange);
  mergeRefundOverlay(paymentSections, overlay, { refundTotal, refundCount });
  // 特殊返金イベントを totals オブジェクト経由で受け取り、ローカル変数に反映する
  const eventTotals = { total, refundTotal };
  applySpecialRefundEventsToTotals(paymentSections, otherEvents, eventTotals);
  total = eventTotals.total;
  refundTotal = eventTotals.refundTotal;

  // 小数は不要運用のため、精算数値はすべて四捨五入（整数）で統一
  const roundInt = (n: number) => Math.round(n);
  const sectionsTotal = roundInt(
    paymentSections.reduce((sum, sec) => sum + Number(sec.net || 0) - Number(sec.refund || 0), 0)
  );
  total = Math.max(0, sectionsTotal);
  const settlementSettings = await getAppSetting<{ taxRatePercent?: number }>(shopId, SETTLEMENT_SETTINGS_KEY);
  const taxRatePercent = Number(settlementSettings?.taxRatePercent) || 10;
  const split = splitTaxInclusiveToNetAndTax(total, taxRatePercent);
  tax = split.tax;
  netSales = split.netSales;

  for (const sec of paymentSections) {
    if (sec.label === sec.gateway) {
      sec.label = await getPaymentMethodDisplayLabel(shopId, sec.gateway);
    }
  }

  paymentSections = paymentSections.map((sec) => ({
    ...sec,
    net: roundInt(sec.net),
    refund: roundInt(sec.refund),
  }));

  return {
    locationId,
    locationName,
    targetDate,
    currency,
    total: roundInt(total),
    netSales: roundInt(netSales),
    tax: roundInt(tax),
    discounts: roundInt(discounts),
    vipPointsUsed: roundInt(vipPointsUsed),
    refundTotal: roundInt(refundTotal),
    orderCount: saleOrderSet.size,
    refundCount: Math.max(refundCount, refundOrderSet.size),
    itemCount,
    voucherChangeAmount: roundInt(voucherChangeAmount),
    paymentSections,
    debug: debugEnabled
      ? {
          ordersRawCount,
          ordersPosSourceMatchedCount,
          ordersAtLocationCount,
          ordersUpdatedRawCount,
          ordersUpdatedPosSourceMatchedCount,
          ordersUpdatedAtLocationCount,
          overlayRefundCount,
        }
      : undefined,
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

// ── CloudPRNT / 印字用テキスト生成 ─────────────────────────────────────────────

/**
 * 精算レシートの印字用テキスト（1行ずつ改行）を組み立てる。
 * order_based 時の注文ノート・cloudprnt_direct 時の printPayload で共通利用。
 */
export function buildSettlementReceiptText(preview: SettlementPreviewDTO): string {
  const lines = [
    "【精算レシート】",
    `日付: ${preview.targetDate}`,
    `ロケーション: ${preview.locationName}`,
    "─────────────────",
    `総売上: ¥${preview.total.toLocaleString()}`,
    `純売上: ¥${preview.netSales.toLocaleString()}`,
    `消費税: ¥${preview.tax.toLocaleString()}`,
    `割引: ¥${preview.discounts.toLocaleString()}`,
    `返金: ¥${preview.refundTotal.toLocaleString()}`,
    `件数: ${preview.orderCount}件 (返金${preview.refundCount}件)`,
    `点数: ${preview.itemCount}点`,
    ...(preview.voucherChangeAmount > 0
      ? [`商品券釣有り差額: ¥${preview.voucherChangeAmount.toLocaleString()}`]
      : []),
    "─────────────────",
    ...preview.paymentSections.map(
      (s) => `${s.label}: ¥${s.net.toLocaleString()} (${s.txCount}件)${s.refund > 0 ? ` 返金${s.refundCount}件 ¥${s.refund.toLocaleString()}` : ""}`
    ),
  ];
  return lines.join("\n");
}
