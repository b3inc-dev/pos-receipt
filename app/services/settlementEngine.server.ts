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
import {
  LOYALTY_SETTINGS_KEY,
  DEFAULT_LOYALTY_SETTINGS,
  SETTLEMENT_SETTINGS_KEY,
  DEFAULT_SETTLEMENT_SETTINGS,
  type SettlementSettings,
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
  resolveRefundAggregationLocationGid,
  locationGidMatches,
  type RefundAggregationContext,
} from "./refundAggregation.server";
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

const GAS_UNKNOWN_GATEWAY = "未分類";

function ensurePayBucket(
  pay: Record<string, { sale: number; refund: number; saleTx: number; refundTx: number }>,
  key: string,
): void {
  if (!pay[key]) pay[key] = { sale: 0, refund: 0, saleTx: 0, refundTx: 0 };
}

/** docs/GAS_精算レシート.md の normalizeGatewayLabel に合わせる */
function gasNormalizeGatewayLabel(gateway: string, formattedGateway?: string | null): string {
  const raw = String(gateway ?? "").trim().toLowerCase();
  const fmt = String(formattedGateway ?? "").trim().toLowerCase();
  const s = `${raw} ${fmt}`.trim();
  if (!s) return GAS_UNKNOWN_GATEWAY;

  const isGift =
    raw === "gift_card" ||
    s.includes("giftcard") ||
    s.includes("gift_card") ||
    s.includes("gift ") ||
    s.includes("voucher") ||
    s.includes("gc") ||
    s.includes("商品券") ||
    s.includes("ギフトカード");

  const hasNoChangeHint =
    s.includes("釣無") ||
    s.includes("釣なし") ||
    s.includes("釣り無し") ||
    s.includes("つりなし") ||
    s.includes("nochange") ||
    s.includes("no change");

  const hasChangeHint =
    s.includes("釣有") ||
    s.includes("釣あり") ||
    s.includes("釣り有り") ||
    s.includes("つりあり") ||
    s.includes("change") ||
    s.includes("with_change") ||
    s.includes("chg") ||
    s.includes("釣銭") ||
    s.includes("おつり");

  if (isGift) {
    if (hasNoChangeHint && !hasChangeHint) return "商品券釣無し";
    if (hasChangeHint) return "商品券釣有り";
    return "商品券";
  }

  if (
    raw === "cash" ||
    raw === "cash_payment" ||
    raw === "manual" ||
    fmt === "現金" ||
    s.includes("現金決済")
  ) {
    return "現金";
  }

  if (raw === "credit_card" || raw === "card" || raw === "creditcard") return "クレジットカード";
  if (s.includes("credit") || s.includes("クレジット")) return "クレジットカード";

  if (s.includes("qr")) return "電子マネー(QR)";
  if (s.includes("edy") || s.includes("waon") || s.includes("nanaco")) return "電子マネー";

  if (
    s.includes("交通系") ||
    s.includes("suica") ||
    s.includes("pasmo") ||
    s.includes("toica") ||
    s.includes("icoca") ||
    s.includes("nimoca") ||
    s.includes("はやかけん") ||
    s.includes("kitaca") ||
    s.includes("icカード") ||
    s.includes("icｶｰﾄﾞ")
  ) {
    return "交通系ICカード決済";
  }

  if (s.includes("id") || s.includes("felica")) return "電子マネー";

  if (raw === "paypal" || s.includes("paypal")) return "PayPal";

  const rawFmt = String(formattedGateway ?? "").trim();
  const rawGw = String(gateway ?? "").trim();
  return rawFmt || rawGw || GAS_UNKNOWN_GATEWAY;
}

function gasTxLabel(tx: ShopifyTransaction | ShopifyRefundTransaction): string {
  return gasNormalizeGatewayLabel(tx.gateway ?? "", tx.formattedGateway);
}

/** GAS z2hDigits: 全角数字・読点を除いて半角化（商品券額面パース用） */
function z2hDigitsForVoucherNote(input: string): string {
  const digitMap: Record<string, string> = {
    "０": "0",
    "１": "1",
    "２": "2",
    "３": "3",
    "４": "4",
    "５": "5",
    "６": "6",
    "７": "7",
    "８": "8",
    "９": "9",
  };
  let s = "";
  for (const ch of String(input ?? "")) {
    s += digitMap[ch] ?? ch;
  }
  return s.replace(/[，、,]/g, "");
}

/** GAS parseVoucherFaceFromNote: 注文ノートの「商品券 2000円」等から額面を抽出 */
function parseVoucherFaceFromNote(note: string | null | undefined): number {
  const s = z2hDigitsForVoucherNote(note ?? "");
  const m = s.match(/商品券\s*([0-9]+)\s*(?:円|えん)?/);
  return m ? Number(m[1]) : 0;
}

const GAS_GATEWAY_CASH = "現金";

/**
 * GAS aggregate の注文ループ（todaysTx・pay・refundsGross・割引/VIP 按分・税 Shopify 相当）。
 * ノート観測: observeVoucherChangeFromFace（キャンセル除外）・GAS cash cap（effectiveCashSale）。
 */
export type GasAggregateAttributionOpts = {
  attributionCtx: RefundAggregationContext;
  settlementLocationId: string;
  locIdRaw: string;
};

function orderRefundsCountForSettlement(
  order: ShopifyOrder,
  inRange: (iso?: string) => boolean,
  opts?: GasAggregateAttributionOpts,
): boolean {
  if (!opts) return true;
  const attr = resolveRefundAggregationLocationGid(order, opts.attributionCtx, inRange);
  return locationGidMatches(attr, opts.settlementLocationId, opts.locIdRaw);
}

function aggregateGasStyleForOrders(
  orders: ShopifyOrder[],
  inRange: (iso?: string) => boolean,
  attributionOpts?: GasAggregateAttributionOpts,
): {
  pay: Record<string, { sale: number; refund: number; saleTx: number; refundTx: number }>;
  refundsGross: number;
  discountsTotal: number;
  vipPointsUsed: number;
  saleOrderSet: Set<string>;
  refundOrderSet: Set<string>;
  itemCount: number;
  taxTotalShopify: number;
  /** GAS _voucher_change_total 相当（ノート・現金お釣りヒューリスティックの観測値のみ） */
  voucherChangeObserved: number;
} {
  const pay: Record<string, { sale: number; refund: number; saleTx: number; refundTx: number }> = {};
  let refundsGross = 0;
  let discountsTotal = 0;
  let vipPointsUsed = 0;
  const saleOrderSet = new Set<string>();
  const refundOrderSet = new Set<string>();
  let itemCount = 0;
  let taxTotalShopify = 0;
  let voucherChangeObserved = 0;

  for (const o of orders) {
    const countRefundsForThisLocation = orderRefundsCountForSettlement(
      o,
      inRange,
      attributionOpts,
    );

    const refundTxIdsInDay = new Set<string>();
    for (const r of o.refunds ?? []) {
      if (!inRange(r.createdAt)) continue;
      for (const e of r.transactions ?? []) {
        if (e?.id) refundTxIdsInDay.add(e.id);
      }
    }

    const txs = o.transactions ?? [];
    const todaysTx = txs.filter((tx) => {
      const byTime = inRange(tx.createdAt);
      const byRefundLink = refundTxIdsInDay.has(tx.id);
      return byTime || (String(tx.kind) === "REFUND" && byRefundLink);
    });

    let orderRefundToday = 0;
    const gwSaleMapToday: Record<string, number> = {};

    for (const tx of todaysTx) {
      const amt = Number(tx.amountSet?.shopMoney?.amount ?? 0);
      const kind = String(tx.kind ?? "");
      const gw = gasTxLabel(tx);
      ensurePayBucket(pay, gw);

      if (kind === "SALE" || kind === "CAPTURE") {
        gwSaleMapToday[gw] = (gwSaleMapToday[gw] || 0) + amt;
        pay[gw].saleTx += 1;
      } else if (kind === "REFUND") {
        if (!countRefundsForThisLocation) continue;
        const r = Math.abs(amt);
        orderRefundToday += r;
        pay[gw].refund += r;
        pay[gw].refundTx += 1;
        refundOrderSet.add(o.id);
      }
    }

    // GAS cash cap: effectiveCashSale = min(rawCash, max(0, orderFinal - nonCash))
    // 返金有無に関わらず常に適用（GAS observeGenericCashChange と同式）
    const rawCashSale = Number(gwSaleMapToday[GAS_GATEWAY_CASH] || 0);
    const nonCashSaleTotal = Object.entries(gwSaleMapToday)
      .filter(([k]) => k !== GAS_GATEWAY_CASH)
      .reduce((acc, [, v]) => acc + Number(v || 0), 0);
    const orderFinal = Number(o.totalPriceSet?.shopMoney?.amount ?? 0);
    let effectiveCashSale = rawCashSale;
    let orderVoucherCashChange = 0;
    if (rawCashSale > 0) {
      const neededCashForOrder = Math.max(0, orderFinal - nonCashSaleTotal);
      effectiveCashSale = Math.min(rawCashSale, neededCashForOrder);
      orderVoucherCashChange = Math.max(0, rawCashSale - effectiveCashSale);
    }
    const hasVoucherInNote = /商品券/.test(o.note ?? "");
    const hasVoucherInGateway = Object.keys(gwSaleMapToday).some((k) => /商品券/.test(k));
    for (const [gw, amt] of Object.entries(gwSaleMapToday)) {
      ensurePayBucket(pay, gw);
      pay[gw].sale += gw === GAS_GATEWAY_CASH ? effectiveCashSale : Number(amt);
    }
    const effectiveOrderSaleToday = nonCashSaleTotal + effectiveCashSale;

    const hasRefundObjToday = refundTxIdsInDay.size > 0;
    const hasRefundTxToday = todaysTx.some((tx) => String(tx.kind) === "REFUND");
    if (countRefundsForThisLocation && hasRefundObjToday && !hasRefundTxToday) {
      let amt = 0;
      let cnt = 0;
      for (const r of o.refunds ?? []) {
        if (!inRange(r.createdAt)) continue;
        for (const e of r.transactions ?? []) {
          const v = Math.abs(Number(e?.amountSet?.shopMoney?.amount ?? 0));
          if (v > 0) {
            amt += v;
            cnt += 1;
          }
        }
      }
      if (amt > 0) {
        const k = GAS_UNKNOWN_GATEWAY;
        ensurePayBucket(pay, k);
        pay[k].refund += amt;
        pay[k].refundTx += Math.max(1, cnt);
        orderRefundToday += amt;
        refundOrderSet.add(o.id);
      }
    }

    const isCancelled = Boolean(o.cancelledAt);

    // GAS observeVoucherChangeFromFace（キャンセル済み注文はノート観測しない）
    let orderVoucherFaceChange = 0;
    if (!isCancelled) {
      const face = parseVoucherFaceFromNote(o.note);
      if (face > 0) {
        const giftAppliedToday =
          Number(gwSaleMapToday["商品券釣有り"] || 0) +
          Number(gwSaleMapToday["商品券釣無し"] || 0) +
          Number(gwSaleMapToday["商品券"] || 0);
        const netToday = effectiveOrderSaleToday - orderRefundToday;
        if (netToday > 0) {
          orderVoucherFaceChange = Math.max(0, face - giftAppliedToday);
        }
      }
    }
    // cashChange と faceChange はどちらか大きい方を1回だけ計上（GAS と同式）
    if ((hasVoucherInNote || hasVoucherInGateway) && (orderVoucherCashChange > 0 || orderVoucherFaceChange > 0)) {
      voucherChangeObserved += Math.max(orderVoucherCashChange, orderVoucherFaceChange);
    }

    if (countRefundsForThisLocation) {
      refundsGross += orderRefundToday;
    }

    if (effectiveOrderSaleToday - (countRefundsForThisLocation ? orderRefundToday : 0) > 0) {
      saleOrderSet.add(o.id);
    }

    if (effectiveOrderSaleToday > 0) {
      const nodes = o.lineItems?.nodes ?? [];
      itemCount += nodes.reduce((s, n) => s + Number(n.quantity ?? 0), 0);
    }
    if (countRefundsForThisLocation && orderRefundToday > 0) {
      for (const r of o.refunds ?? []) {
        if (!inRange(r.createdAt)) continue;
        for (const ri of r.refundLineItems ?? []) {
          itemCount -= Number(ri.quantity ?? 0);
        }
      }
      refundOrderSet.add(o.id);
    }

    let orderDiscount = 0;
    let orderVip = 0;
    for (const li of o.lineItems?.nodes ?? []) {
      for (const da of li.discountAllocations ?? []) {
        const alloc = Number(da.allocatedAmountSet?.shopMoney?.amount ?? 0);
        const typ = da.discountApplication?.__typename ?? "";
        const code =
          typ === "DiscountCodeApplication" ? String(da.discountApplication?.code ?? "") : "";
        if (code && code.toUpperCase().startsWith("VIP-")) {
          orderVip += alloc;
        } else {
          orderDiscount += alloc;
        }
      }
    }

    let keepRatioToday = 0;
    if (effectiveOrderSaleToday > 0) {
      keepRatioToday = Math.max(0, effectiveOrderSaleToday - orderRefundToday) / effectiveOrderSaleToday;
    }
    discountsTotal += orderDiscount * keepRatioToday;
    vipPointsUsed += orderVip * keepRatioToday;

    const oTax = Number(
      o.currentTotalTaxSet?.shopMoney?.amount ?? o.totalTaxSet?.shopMoney?.amount ?? 0,
    );
    taxTotalShopify += oTax * keepRatioToday;
  }

  return {
    pay,
    refundsGross,
    discountsTotal: Math.round(discountsTotal),
    vipPointsUsed: Math.round(vipPointsUsed),
    saleOrderSet,
    refundOrderSet,
    itemCount,
    taxTotalShopify: Math.round(taxTotalShopify),
    voucherChangeObserved: Math.round(voucherChangeObserved),
  };
}

function totalFromPayBuckets(
  pay: Record<string, { sale: number; refund: number; saleTx: number; refundTx: number }>,
): number {
  let sum = 0;
  for (const p of Object.values(pay)) {
    sum += Math.round((p.sale || 0) - (p.refund || 0));
  }
  return Math.round(sum);
}

async function payBucketsToPaymentSections(
  pay: Record<string, { sale: number; refund: number; saleTx: number; refundTx: number }>,
  shopId: string,
): Promise<PaymentSectionDTO[]> {
  const entries = Object.entries(pay);
  entries.sort((a, b) => a[0].localeCompare(b[0], "ja"));
  const out: PaymentSectionDTO[] = [];
  for (const [key, p] of entries) {
    out.push({
      gateway: key,
      label: key,
      net: p.sale,
      refund: p.refund,
      txCount: p.saleTx,
      refundCount: p.refundTx,
    });
  }
  for (const sec of out) {
    if (/^[a-z0-9_.]+$/i.test(sec.gateway)) {
      sec.label = await getPaymentMethodDisplayLabel(shopId, sec.gateway);
    }
  }
  return out;
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
  const locIdRaw = locationId.replace("gid://shopify/Location/", "");
  if (!locIdRaw || !/^\d+$/.test(locIdRaw)) {
    throw new Error(`Invalid locationId: "${locationId}"`);
  }

  // ショップタイムゾーンで「その日」の UTC 範囲を算出
  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dayRange = getDayRangeInUtc(targetDate, timezone);

  // GAS fetchAllOrdersSmart と同型: created∪updated∪cancelled の3クエリ union
  // source_name:pos フィルタなし・retailLocation 二次フィルタなし（GAS と同一）
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

  const voucherAdjustments = specialRefundEvents.filter(
    (e) => e.eventType === "voucher_change_adjustment"
  );
  const otherEvents = specialRefundEvents.filter(
    (e) => e.eventType !== "voucher_change_adjustment"
  );

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
  applySpecialRefundEventsToTotals(paymentSections, otherEvents, eventTotals);
  total = eventTotals.total;
  refundTotal = eventTotals.refundTotal;

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

  for (const sec of paymentSections) {
    if (/^[a-z0-9_.]+$/i.test(sec.gateway) && sec.label === sec.gateway) {
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
