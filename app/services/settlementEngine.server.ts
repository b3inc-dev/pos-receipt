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
import { resolvePaymentSectionLabels } from "../utils/paymentMethod.server";
import { getAppSetting } from "../utils/appSettings.server";
import {
  LOYALTY_SETTINGS_KEY,
  DEFAULT_LOYALTY_SETTINGS,
  SETTLEMENT_SETTINGS_KEY,
  DEFAULT_SETTLEMENT_SETTINGS,
  SPECIAL_REFUND_SETTINGS_KEY,
  DEFAULT_SPECIAL_REFUND_SETTINGS,
  type SettlementSettings,
  type SpecialRefundSettings,
} from "../utils/appSettings.server";
import { fetchLegacyGiftCardIssuanceForDay } from "./settlementLegacyGiftCards.server";
import {
  getShopTimezoneForDaily,
  getDayRangeInUtc,
  getDayRangeShopifySearchIso,
  formatTimeHmInTimeZone,
} from "../utils/shopTimezone.server";
import {
  loadRefundAggregationContext,
  type RefundAggregationContext,
} from "./refundAggregation.server";
import {
  aggregateGasStyleForOrders,
  ensurePayBucket,
  gasNormalizeGatewayLabel,
  totalFromPayBuckets,
  type GasAggregateAttributionOpts,
} from "./settlementAggregatePure.server";
import { extractLocationNumericId } from "./refundAggregationPure.server";
import { applySpecialRefundEventsToTotals } from "./specialRefundOverlayPure.server";

export type { GasAggregateAttributionOpts } from "./settlementAggregatePure.server";
import {
  adminGraphqlWithRetry,
  GRAPHQL_PAGE_DELAY_MS,
  runSettlementGraphqlSerial,
  sleep,
} from "../lib/shopifyGraphqlThrottle.server";

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
  /**
   * GAS aggregate: 当日かつ対象注文の transactions の createdAt の最小・最大を店舗TZの HH:mm で表したもの。
   * 無い場合は null（period_label は 00:00–23:59 フォールバック）。
   */
  settlementTxFirstHm: string | null;
  settlementTxLastHm: string | null;
  /** GAS _tax_shopify: currentTotalTax × keepRatioToday を注文ごとに合算 */
  taxShopify: number;
  /**
   * 旧運用: Shopify ギフトカード API で加算した発行額（POS 注文に既にある分は除外）。
   * 精算設定で「旧ギフトカード API 集計」が OFF のときは undefined。
   */
  legacyGiftCardsAddedAmount?: number;
  legacyGiftCardsAddedCount?: number;
}

export interface SettlementPreviewDebugDTO {
  /** created_at クエリ取得件数 */
  ordersRawCount: number;
  /** 互換用（ordersRawCount と同じ） */
  ordersPosSourceMatchedCount: number;
  /** created∪updated∪cancelled ユニオン後の件数（GAS 型集計の入力） */
  ordersAtLocationCount: number;
  ordersUpdatedRawCount: number;
  ordersUpdatedPosSourceMatchedCount: number;
  ordersUpdatedAtLocationCount: number;
  /** ユニオン集計のため常に 0 */
  overlayRefundCount: number;
  /**
   * 返金帰属: 注文 metafield(pos.refund_aggregation_location_gid) と
   * 実行時 resolve 結果が不一致だった件数（金額ロジックは metafield 優先のまま）
   */
  refundAttributionMismatchCount?: number;
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
  /** GAS normalizeGatewayLabel の formatted 側 */
  formattedGateway?: string | null;
  location?: { id: string } | null;
}

interface ShopifyRefundTransaction {
  id: string;
  kind: string;
  gateway: string;
  formattedGateway?: string | null;
  amountSet: { shopMoney: { amount: string; currencyCode: string } };
  location?: { id: string } | null;
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
  /** GAS observeVoucherChangeFromFace / observeGenericCashChange 用 */
  note?: string | null;
  cancelledAt?: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  /** GAS currentTotalTaxSet 相当（注文の現在の税合計） */
  currentTotalTaxSet?: { shopMoney: { amount: string } } | null;
  totalTaxSet: { shopMoney: { amount: string } };
  totalDiscountsSet: { shopMoney: { amount: string } };
  lineItems: {
    nodes: {
      quantity: number;
      discountAllocations?: {
        allocatedAmountSet: { shopMoney: { amount: string } };
        discountApplication?: {
          __typename: string;
          code?: string | null;
          title?: string | null;
        } | null;
      }[];
    }[];
  };
  transactions: ShopifyTransaction[];
  refunds: ShopifyRefund[];
  tags: string[];
  retailLocation?: { id: string } | null;
  /** GAS fetchAllOrdersSmart フォールバック（processed_at）用 */
  processedAt?: string | null;
  /** pos.refund_aggregation_location_gid（集計時 metafield 優先） */
  refundAggregationLocationGid?: string | null;
}

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

// ── GraphQL Query ─────────────────────────────────────────────────────────────

const SETTLEMENT_ORDERS_QUERY = `#graphql
  query SettlementOrders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys!) {
    orders(first: $first, after: $after, query: $query, sortKey: $sortKey) {
      nodes {
        id
        name
        note
        cancelledAt
        totalPriceSet { shopMoney { amount currencyCode } }
        currentTotalTaxSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        lineItems(first: 250) {
          nodes {
            quantity
            discountAllocations {
              allocatedAmountSet { shopMoney { amount } }
              discountApplication {
                __typename
                ... on DiscountCodeApplication { code }
                ... on ManualDiscountApplication { title }
                ... on AutomaticDiscountApplication { title }
                ... on ScriptDiscountApplication { title }
              }
            }
          }
        }
        transactions(first: 50) {
          id
          createdAt
          kind
          status
          amountSet { shopMoney { amount currencyCode } }
          gateway
          formattedGateway
          location { id }
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
              formattedGateway
              amountSet { shopMoney { amount currencyCode } }
              location { id }
            }
          }
        }
        tags
        processedAt
        retailLocation { id }
        metafield(namespace: "pos", key: "refund_aggregation_location_gid") {
          value
        }
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

/** 返金再集計用: updated_at でその日に更新された注文を取得（refunds.createdAt でフィルタするため） */
const REFUNDS_ORDERS_QUERY = `#graphql
  query RefundsOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes {
        id
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

async function fetchAllOrders(
  admin: AdminClient,
  query: string,
  sortKey: "CREATED_AT" | "UPDATED_AT" = "CREATED_AT",
): Promise<ShopifyOrder[]> {
  const orders: ShopifyOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const json = await adminGraphqlWithRetry<{
      data?: {
        orders?: {
          nodes?: (ShopifyOrder & {
            refunds?: (Omit<ShopifyRefund, "transactions"> & { transactions?: { nodes?: ShopifyRefundTransaction[] } })[];
          })[];
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    }>(
      admin,
      SETTLEMENT_ORDERS_QUERY,
      { variables: { first: 100, after: cursor, query, sortKey } },
      "settlementOrders",
    );

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const node of nodes) {
      // クエリで -tag:SETTLEMENT 済みだが、タグ表記ゆれ（SETTLEMENT / settlement）に備えて大文字小文字無視で除外
      const isSettlement = (node.tags ?? []).some((t) => String(t).toLowerCase() === "settlement");
      if (!isSettlement) {
        const nodeWithMf = node as ShopifyOrder & {
          metafield?: { value?: string | null } | null;
        };
        const mfVal = nodeWithMf.metafield?.value?.trim() || null;
        const order: ShopifyOrder = {
          ...node,
          transactions: node.transactions ?? [],
          refunds: (node.refunds ?? []).map((r) => ({
            ...r,
            refundLineItems: r.refundLineItems?.nodes ?? [],
            transactions: r.transactions?.nodes ?? [],
          })),
          refundAggregationLocationGid: mfVal,
        };
        orders.push(order);
      }
    }

    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
    if (hasNextPage) await sleep(GRAPHQL_PAGE_DELAY_MS);
  }

  return orders;
}

/** 返金再集計用: その日に updated された注文を取得（refunds に createdAt 含む） */
interface OrderWithRefundsCreatedAt {
  id: string;
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
    if (!rid) return false;
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
    const json = await adminGraphqlWithRetry<{
      data?: {
        orders?: {
          nodes?: (OrderWithRefundsCreatedAt & {
            refunds?: (Omit<ShopifyRefund, "transactions"> & { transactions?: { nodes?: ShopifyRefundTransaction[] } })[];
          })[];
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    }>(
      admin,
      REFUNDS_ORDERS_QUERY,
      { variables: { first: 100, after: cursor, query } },
      "refundsOrders",
    );

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const node of nodes) {
      const isSettlement = (node.tags ?? []).some((t) => String(t).toLowerCase() === "settlement");
      if (!isSettlement) {
        orders.push({
          id: node.id,
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
    if (hasNextPage) await sleep(GRAPHQL_PAGE_DELAY_MS);
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
 * buildSettlementPreview と同じ境界で updated_at 検索した注文から返金のみを集計する。
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
  const updatedQuery = `location_id:${locIdRaw} updated_at:>=${startIso} updated_at:<=${endIso} tag_not:settlement`;
  const ordersUpdated = await fetchOrdersUpdatedInDayRange(admin, updatedQuery);
  const ordersUpdatedAtLocation = filterOrdersUpdatedByRetailLocation(ordersUpdated, locationGid, locIdRaw);
  const overlay = computeRefundsOnlyForDay(ordersUpdatedAtLocation, orderIdsCreatedInDay, dayRange);
  return { refundTotal: overlay.refundTotal };
}

/** GAS: その日 created の注文に、その日 updated のスナップショットを上書きマージ */
function unionSettlementOrdersById(created: ShopifyOrder[], updated: ShopifyOrder[]): ShopifyOrder[] {
  const m = new Map<string, ShopifyOrder>();
  for (const o of created) m.set(o.id, o);
  for (const o of updated) m.set(o.id, o);
  return [...m.values()];
}

// 支払バケット / 件数 / 返金帰属ゲートの純関数は settlementAggregatePure.server.ts へ分離

async function payBucketsToPaymentSections(
  pay: Record<string, { sale: number; refund: number; saleTx: number; refundTx: number }>,
  shopId: string,
): Promise<PaymentSectionDTO[]> {
  const entries = Object.entries(pay);
  entries.sort((a, b) => a[0].localeCompare(b[0], "ja"));
  const labels = await resolvePaymentSectionLabels(
    shopId,
    entries.map(([key]) => key),
  );
  const out: PaymentSectionDTO[] = [];
  for (const [key, p] of entries) {
    out.push({
      gateway: key,
      label: labels.get(key) ?? key,
      net: p.sale,
      refund: p.refund,
      txCount: p.saleTx,
      refundCount: p.refundTx,
    });
  }
  return out;
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

/** GAS aggregate: 当日 inRange の全 transaction.createdAt から first/last の HH:mm（店舗TZ） */
function computeGasSettlementTxTimeBounds(
  orders: ShopifyOrder[],
  inDay: (iso?: string) => boolean,
  ianaTimezone: string,
): { firstHm: string | null; lastHm: string | null } {
  const isoList: string[] = [];
  for (const o of orders) {
    for (const tx of o.transactions) {
      const iso = tx.createdAt;
      if (iso && inDay(iso)) isoList.push(iso);
    }
  }
  if (isoList.length === 0) return { firstHm: null, lastHm: null };
  isoList.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return {
    firstHm: formatTimeHmInTimeZone(isoList[0], ianaTimezone),
    lastHm: formatTimeHmInTimeZone(isoList[isoList.length - 1], ianaTimezone),
  };
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
  return runSettlementGraphqlSerial(shopId, () =>
    buildSettlementPreviewImpl(admin, shopId, locationId, locationName, targetDate, opts),
  );
}

async function buildSettlementPreviewImpl(
  admin: AdminClient,
  shopId: string,
  locationId: string,
  locationName: string,
  targetDate: string,
  opts?: { debug?: boolean },
): Promise<SettlementPreviewDTO> {
  const debugEnabled = opts?.debug === true;
  const locIdRaw = extractLocationNumericId(locationId);
  if (!locIdRaw) {
    throw new Error(`Invalid locationId: "${locationId}"`);
  }

  // ショップタイムゾーンで「その日」の UTC 範囲を算出
  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dayRange = getDayRangeInUtc(targetDate, timezone);

  // 精算の注文境界（D1 / BUSINESS_RULES §1）:
  // - 絞り込みは location_id（数値）+ 日付レンジ + tag_not:settlement のみ
  // - source_name:pos は付けない（注文検索ピッカーとは意図的に異なる）
  // - retailLocation 二次フィルタもメイン集計では行わない（GAS fetchAllOrdersSmart 同型）
  const qCreated   = `location_id:${locIdRaw} created_at:>=${dayRange.startUtcIso} created_at:<=${dayRange.endUtcIso} tag_not:settlement -status:cancelled`;
  const qUpdated   = `location_id:${locIdRaw} updated_at:>=${dayRange.startUtcIso} updated_at:<=${dayRange.endUtcIso} tag_not:settlement -status:cancelled`;
  const qCancelled = `location_id:${locIdRaw} updated_at:>=${dayRange.startUtcIso} updated_at:<=${dayRange.endUtcIso} tag_not:settlement status:cancelled`;

  const createdRaw   = await fetchAllOrders(admin, qCreated, "CREATED_AT");
  await sleep(GRAPHQL_PAGE_DELAY_MS);
  const updatedRaw   = await fetchAllOrders(admin, qUpdated, "UPDATED_AT");
  await sleep(GRAPHQL_PAGE_DELAY_MS);
  const cancelledRaw = await fetchAllOrders(admin, qCancelled, "UPDATED_AT");
  await sleep(GRAPHQL_PAGE_DELAY_MS);

  let ordersUnion = unionSettlementOrdersById(
    unionSettlementOrdersById(createdRaw, updatedRaw),
    cancelledRaw,
  );

  // GAS fetchAllOrdersSmart ③: 0件のとき processed_at（店舗TZの暦日）でフォールバック
  if (ordersUnion.length === 0) {
    const processedRange = getDayRangeShopifySearchIso(targetDate, timezone);
    const qProcessed = `location_id:${locIdRaw} processed_at:>=${processedRange.start} processed_at:<=${processedRange.end} tag_not:settlement -status:cancelled`;
    const processedRaw = await fetchAllOrders(admin, qProcessed, "CREATED_AT");
    ordersUnion = processedRaw.filter((o) => {
      if (!o.processedAt) return false;
      const t = new Date(o.processedAt).getTime();
      return t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime();
    });
  }

  const attributionCtx = await loadRefundAggregationContext(shopId);
  const attributionOpts: GasAggregateAttributionOpts = {
    attributionCtx,
    settlementLocationId: locationId,
    locIdRaw,
  };

  // debug フィールド名に PosSource とあるが、精算は source_name:pos 未適用のため件数は raw と同値（互換のためキー名維持）
  const ordersRawCount = createdRaw.length;
  const ordersPosSourceMatchedCount = createdRaw.length;
  const ordersAtLocationCount = ordersUnion.length;
  const ordersUpdatedRawCount = updatedRaw.length;
  const ordersUpdatedPosSourceMatchedCount = updatedRaw.length;
  const ordersUpdatedAtLocationCount = updatedRaw.length;
  const overlayRefundCount = 0;

  const inDay = (iso?: string) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime();
  };

  const gas = aggregateGasStyleForOrders(ordersUnion, inDay, attributionOpts);

  const settlementSettings = await getAppSetting<Partial<SettlementSettings>>(shopId, SETTLEMENT_SETTINGS_KEY);
  const settlementMerged: SettlementSettings = { ...DEFAULT_SETTLEMENT_SETTINGS, ...settlementSettings };

  const legacyGiftOn = settlementMerged.legacyGiftCardAggregationEnabled === true;
  let legacyGiftCardsAddedAmount = 0;
  let legacyGiftCardsAddedCount = 0;
  if (legacyGiftOn) {
    const posOrderIds = new Set(ordersUnion.map((o) => o.id));
    try {
      const leg = await fetchLegacyGiftCardIssuanceForDay(
        admin,
        dayRange,
        locationId,
        locationName,
        posOrderIds,
      );
      legacyGiftCardsAddedAmount = leg.amount;
      legacyGiftCardsAddedCount = leg.count;
      if (leg.amount > 0) {
        const bucket = gasNormalizeGatewayLabel("gift_card", null);
        ensurePayBucket(gas.pay, bucket);
        gas.pay[bucket].sale += leg.amount;
        gas.pay[bucket].saleTx += leg.count;
      }
    } catch {
      // read_gift_cards 未付与・API 差異時は加算せず続行
    }
  }

  const { firstHm: settlementTxFirstHm, lastHm: settlementTxLastHm } = computeGasSettlementTxTimeBounds(
    ordersUnion,
    inDay,
    timezone,
  );
  const taxShopify = gas.taxTotalShopify;

  const currency = ordersUnion[0]?.totalPriceSet?.shopMoney?.currencyCode ?? "JPY";

  let total = totalFromPayBuckets(gas.pay);
  let refundTotal = Math.round(gas.refundsGross);
  let discounts = gas.discountsTotal;
  const itemCount = gas.itemCount;

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

  const srSettingsRaw = await getAppSetting<Partial<SpecialRefundSettings>>(
    shopId,
    SPECIAL_REFUND_SETTINGS_KEY,
  );
  const srSettings: SpecialRefundSettings = {
    ...DEFAULT_SPECIAL_REFUND_SETTINGS,
    ...srSettingsRaw,
  };

  const voucherAdjustmentsAll = specialRefundEvents.filter(
    (e) => e.eventType === "voucher_change_adjustment",
  );
  const otherEventsAll = specialRefundEvents.filter(
    (e) => e.eventType !== "voucher_change_adjustment",
  );

  const voucherAdjustments = srSettings.reflectVoucherAdjustmentToSettlement
    ? voucherAdjustmentsAll
    : [];
  const otherEvents = otherEventsAll.filter((e) => {
    if (e.eventType === "cash_refund") return srSettings.reflectCashRefundToSettlement;
    if (e.eventType === "payment_method_override") {
      return srSettings.reflectPaymentOverrideToSettlement;
    }
    if (e.eventType === "receipt_cash_adjustment") {
      return srSettings.reflectReceiptCashAdjustmentToSettlement;
    }
    return true;
  });

  /** DB の手入力調整 + ノート観測（GAS _voucher_change_total と同系） */
  const voucherChangeAmount =
    Math.round(gas.voucherChangeObserved) +
    voucherAdjustments.reduce((sum, e) => sum + Number(e.voucherChangeAmount ?? 0), 0);
  /** GAS: lineItems の VIP- 割引按分のみ（特殊返金の points は後続フェーズで合成可） */
  const vipPointsUsed = gas.vipPointsUsed;

  const loyaltySettings = await getAppSetting<{ loyaltyUsageDisplayLabel?: string }>(shopId, LOYALTY_SETTINGS_KEY);
  const loyaltyUsageDisplayLabel =
    loyaltySettings?.loyaltyUsageDisplayLabel ?? DEFAULT_LOYALTY_SETTINGS.loyaltyUsageDisplayLabel;

  let paymentSections = await payBucketsToPaymentSections(gas.pay, shopId);
  const eventTotals = { total, refundTotal };
  applySpecialRefundEventsToTotals(
    paymentSections,
    otherEvents.map((e) => ({
      eventType: e.eventType,
      amount: e.amount,
      originalPaymentMethod: e.originalPaymentMethod,
      actualRefundMethod: e.actualRefundMethod,
      adjustKind: e.adjustKind,
      shopifyRefundStatus: e.shopifyRefundStatus,
    })),
    eventTotals,
  );
  total = eventTotals.total;
  refundTotal = eventTotals.refundTotal;

  if (gas.refundAttributionMismatchCount > 0) {
    console.warn(
      `[settlement] refund attribution metafield≠resolve mismatches=${gas.refundAttributionMismatchCount} shop=${shopId} location=${locationId} date=${targetDate}`,
    );
  }

  // 小数は不要運用のため、精算数値はすべて四捨五入（整数）で統一
  const roundInt = (n: number) => Math.round(n);
  const sectionsTotal = roundInt(
    paymentSections.reduce((sum, sec) => sum + Number(sec.net || 0) - Number(sec.refund || 0), 0)
  );
  total = Math.max(0, sectionsTotal);
  const taxRatePercent = Number(settlementMerged.taxRatePercent) || 10;
  const split = splitTaxInclusiveToNetAndTax(total, taxRatePercent);
  const tax = split.tax;
  const netSales = split.netSales;

  // 表示ラベルは payBucketsToPaymentSections でマスタ解決済み（英数字・日本語キーとも）

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
    orderCount: gas.saleOrderSet.size,
    refundCount: gas.refundOrderSet.size,
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
          refundAttributionMismatchCount: gas.refundAttributionMismatchCount,
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
    settlementTxFirstHm,
    settlementTxLastHm,
    taxShopify,
    ...(legacyGiftOn ? { legacyGiftCardsAddedAmount, legacyGiftCardsAddedCount } : {}),
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
