/**
 * Settlement Engine
 * 要件書 §6: 精算エンジン
 *
 * - Shopify注文データから日次売上を集計（ショップタイムゾーンで「その日」の境界を算出）
 * - 支払方法別内訳（payment sections）を算出
 * - 返金方法変更・商品券釣銭登録イベントを合計・payment sections に反映
 * - 支払方法マスタ・ポイント/会員施策設定を参照
 */
import { searchDateRange } from "../utils/shopifySearchDate";
import prisma from "../db.server";
import {
  loadPaymentKeyMasters,
  loadRefundMethodResolver,
  resolvePaymentSectionLabels,
} from "../utils/paymentMethod.server";
import { paymentKeyResolverFor } from "./paymentKeyMasterPure.server";
import { getAppSetting } from "../utils/appSettings.server";
import { resolvePointRedemptionRules } from "../utils/pointRedemptionRules";
import {
  LOYALTY_SETTINGS_KEY,
  DEFAULT_LOYALTY_SETTINGS,
  type LoyaltySettings,
  SETTLEMENT_SETTINGS_KEY,
  DEFAULT_SETTLEMENT_SETTINGS,
  SPECIAL_REFUND_SETTINGS_KEY,
  DEFAULT_SPECIAL_REFUND_SETTINGS,
  type SettlementSettings,
  type SpecialRefundSettings,
  VOUCHER_SETTINGS_KEY,
  DEFAULT_VOUCHER_SETTINGS,
  type VoucherSettings,
} from "../utils/appSettings.server";
import { fetchLegacyGiftCardIssuanceForDay } from "./settlementLegacyGiftCards.server";
import {
  resolveVoucherChange,
  resolveVoucherSettings,
  voucherDetectionRulesFromSettings,
} from "./voucherChangePure.server";
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
  mergeCrossLocationRefundOrders,
  totalFromPayBuckets,
  type GasAggregateAttributionOpts,
} from "./settlementAggregatePure.server";
import { extractLocationNumericId } from "./refundAggregationPure.server";
import {
  applySpecialRefundEventsToTotals,
  assertNoPendingSpecialRefunds,
  unmatchedRefundWarningMessage,
  type UnmatchedRefundMethodWarning,
  SpecialRefundPendingError,
} from "./specialRefundOverlayPure.server";
import { fetchGiftCardRefundsForDay } from "./settlementGiftCardRefunds.server";
import {
  awaitingApprovalWarningMessage,
  partitionSpecialRefundEventsByApproval,
  type AwaitingApprovalSpecialRefund,
} from "../utils/specialRefundApproval";
import {
  SETTLEMENT_CALC_SETTINGS_KEY,
  paymentSectionTxCount,
  resolveSettlementCalcSettings,
  type SettlementCalcSettings,
} from "../utils/settlementCalcSettings";
import {
  FEE_LINE_ITEM_GRAPHQL_FIELDS,
  type FeeLineItemLike,
  type FeeRefundLineItemLike,
} from "./nonSalesFeeLines";

export type { GasAggregateAttributionOpts } from "./settlementAggregatePure.server";
import {
  adminGraphqlWithRetry,
  GRAPHQL_PAGE_DELAY_MS,
  runSettlementGraphqlSerial,
  sleep,
} from "../lib/shopifyGraphqlThrottle.server";
import { readOrdersPageOrThrow } from "./settlementUpstreamPage.server";
import {
  fetchOrderAdjustmentDocs,
  isOrderAdjustmentsMetafieldEnabled,
  syncOrderAdjustmentsMetafield,
} from "./orderAdjustments.server";
import {
  ADJUSTMENT_REWRITE_COOLDOWN_MS,
  adjustmentSourceWarningMessage,
  groupAdjustmentRowsByOrder,
  isOrderWrittenSinceSwitch,
  orderDocMismatch,
  resolveSettlementAdjustments,
  toOrderGid,
  type AdjustmentSourceWarning,
} from "./orderAdjustmentsPure.server";
import { autoResolveStalePendingSpecialRefunds } from "./specialRefundAutoResolve.server";
import { splitTaxInclusiveToNetAndTax } from "./settlementTaxPure.server";

/** 1 回の精算のプレビューで、注文の返金方法変更・商品券釣銭登録を書き直す注文の数の上限 */
const MAX_ADJUSTMENT_RESYNC_PER_PREVIEW = 20;

/**
 * 精算で注文の返金方法変更・商品券釣銭登録を書き直した時刻（店と注文ごと）。
 * 少し前に書き直した注文がまた違うときは、続けて書き換えずに知らせる（ほかのアプリと書き合いにならないように）。
 * サーバーの中だけで持つ（再起動で消える。消えても 1 回書き直すだけ）。
 */
const recentAdjustmentRewrites = new Map<string, number>();

/** テスト用: 精算で書き直した時刻を消す */
export function resetRecentAdjustmentRewritesForTest(): void {
  recentAdjustmentRewrites.clear();
}

function recentlyRewrittenOrders(shopId: string, now: number): Set<string> {
  const out = new Set<string>();
  for (const [key, at] of recentAdjustmentRewrites) {
    if (now - at >= ADJUSTMENT_REWRITE_COOLDOWN_MS) {
      recentAdjustmentRewrites.delete(key);
      continue;
    }
    const [s, orderGid] = key.split("|");
    if (s === shopId) out.add(orderGid);
  }
  return out;
}

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
  /** 商品券釣有り差額の内訳（判定優先順位で外した額。版の無い設定では legacy: true で外さない） */
  voucherChangeBreakdown?: {
    autoTotal: number;
    manualTotal: number;
    skippedAutoAmount: number;
    skippedManualAmount: number;
    legacy: boolean;
    /** 納金金額（現金）から引く商品券の釣銭。POS の納金金額・精算レシートの納金額はこれを引いた額 */
    cashDepositDeduction: number;
  };
  paymentSections: PaymentSectionDTO[];
  /**
   * 売上に含めない手数料の明細（`_lsi_fee="1"` かつ `_lsi_fee_sales="0"`。例: Location Stock の送料の行）の当日分。
   * 支払方法別の金額には入ったまま、総売上・純売上・消費税・点数・割引からは外している。
   * 支払方法別の合計 − 総売上 = この金額（総売上が 0 で止まる日を除く）。
   */
  nonSalesFeeTotal: number;
  /**
   * recompute 時の原因切り分け用デバッグ情報。
   * 通常時は入れない（重くなるため）。
   */
  debug?: SettlementPreviewDebugDTO;
  /**
   * 特殊返金のうち支払方法の行にきちんと載せられなかったもの（無いときは入れない）。
   * マスタに無い返金方法は「未分類」の行に入っている。精算は確定できる（合計は正しい）。
   */
  unmatchedRefundMethods?: (UnmatchedRefundMethodWarning & { message: string })[];
  /**
   * 管理者の承認待ちの返金手段変更（設定でオンのときだけ。無いときは入れない）。
   * 上の金額には入っていない。精算は確定できる（承認したあとは再集計で入る）。
   */
  awaitingApprovalSpecialRefunds?: AwaitingApprovalSpecialRefund[];
  awaitingApprovalWarning?: string;
  /**
   * 返金方法変更・商品券釣銭登録の注文メタフィールドが無い・読めない・アプリの記録と違い、書き直せなかった注文（無いときは入れない）。
   * 精算はいつもアプリの記録で数え、確定できる（注文を読むほかのアプリとずれることがある）。
   */
  adjustmentSourceWarnings?: {
    reason: AdjustmentSourceWarning["reason"] | "metafield_unreadable";
    sourceOrderId: string;
    sourceOrderName: string | null;
    message: string;
  }[];
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
  /**
   * 「精算の数え方」でギフトカードの返金を ON にした店だけ: その日に返金として引いたギフトカードの額と枚数。
   * OFF のときは undefined。
   */
  giftCardRefundAmount?: number;
  giftCardRefundCount?: number;
  /**
   * allowPendingSpecialRefunds のときだけ。Shopify 返金の成否が分からない特殊返金の注文。
   * この金額は上乗せも振替もしていない（数に入っていない）。
   */
  pendingSpecialRefundOrderLabels?: string[];
}

export interface SettlementPreviewOptions {
  debug?: boolean;
  /**
   * true のとき、pending の特殊返金があっても止めずに pendingSpecialRefundOrderLabels を返す。
   * 確定しない読み方（プレビュー・点検）だけで使う。精算の確定・再確定・再集計では使わない（D18）。
   */
  allowPendingSpecialRefunds?: boolean;
  /**
   * false のとき、注文の返金方法変更・商品券釣銭登録が違っても書き直さず、警告だけ出す（調べるだけの呼び出し用。見直し P3）。
   * 初めは true。
   */
  resyncOrderAdjustments?: boolean;
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
  parentTransaction?: { id: string } | null;
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
  refundLineItems?: (Omit<FeeRefundLineItemLike, "quantity" | "lineItem"> & {
    quantity: number;
    lineItem?: {
      id?: string | null;
      sku?: string | null;
      originalUnitPriceSet?: { shopMoney: { amount: string } } | null;
    } | null;
  })[];
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
  taxesIncluded?: boolean | null;
  lineItems: {
    nodes: (Omit<FeeLineItemLike, "quantity" | "discountAllocations"> & {
      quantity: number;
      sku?: string | null;
      originalUnitPriceSet?: { shopMoney: { amount: string } } | null;
      discountAllocations?: {
        allocatedAmountSet: { shopMoney: { amount: string } };
        discountApplication?: {
          __typename: string;
          code?: string | null;
          title?: string | null;
        } | null;
      }[];
    })[];
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
        taxesIncluded
        lineItems(first: 250) {
          nodes {
            quantity
            sku
            originalUnitPriceSet { shopMoney { amount } }${FEE_LINE_ITEM_GRAPHQL_FIELDS}
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
          parentTransaction { id }
          amountSet { shopMoney { amount currencyCode } }
          gateway
          formattedGateway
          location { id }
        }
        refunds {
          id
          createdAt
          refundLineItems(first: 250) {
            pageInfo { hasNextPage }
            nodes {
              quantity
              lineItem { id sku originalUnitPriceSet { shopMoney { amount } } }
              subtotalSet { shopMoney { amount } }
              totalTaxSet { shopMoney { amount } }
            }
          }
          totalRefundedSet { shopMoney { amount currencyCode } }
          transactions(first: 50) {
            pageInfo { hasNextPage }
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
            pageInfo { hasNextPage }
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
  const seenCursors = new Set<string>();

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
    readOrdersPageOrThrow(json, "settlementOrders", seenCursors);

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
  const seenCursors = new Set<string>();

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
    readOrdersPageOrThrow(json, "refundsOrders", seenCursors);

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
  const updatedQuery = `location_id:${locIdRaw} ${searchDateRange("updated_at", startIso, endIso)} tag_not:settlement`;
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
  txCountMode: SettlementCalcSettings["paymentTxCountMode"] = "sales",
  paymentKeySource: SettlementCalcSettings["paymentKeySource"] = "builtin",
): Promise<PaymentSectionDTO[]> {
  const entries = Object.entries(pay);
  entries.sort((a, b) => a[0].localeCompare(b[0], "ja"));
  const labels = await resolvePaymentSectionLabels(
    shopId,
    entries.map(([key]) => key),
    paymentKeySource === "master" ? { preferExactDisplayLabel: true } : undefined,
  );
  const out: PaymentSectionDTO[] = [];
  for (const [key, p] of entries) {
    out.push({
      gateway: key,
      label: labels.get(key) ?? key,
      net: p.sale,
      refund: p.refund,
      txCount: paymentSectionTxCount(p.saleTx, p.refundTx, txCountMode),
      refundCount: p.refundTx,
    });
  }
  return out;
}

/** @deprecated import from settlementTaxPure.server — 再エクスポート（後方互換） */
export { splitTaxInclusiveToNetAndTax };

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
  opts?: SettlementPreviewOptions,
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
  opts?: SettlementPreviewOptions,
): Promise<SettlementPreviewDTO> {
  const debugEnabled = opts?.debug === true;
  const locIdRaw = extractLocationNumericId(locationId);
  if (!locIdRaw) {
    throw new Error(`Invalid locationId: "${locationId}"`);
  }

  // ショップタイムゾーンで「その日」の UTC 範囲を算出
  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dayRange = getDayRangeInUtc(targetDate, timezone);

  // 返金処理中（pending）のまま数分たった特殊返金を、Shopify を読み直して success / failed に決める
  // （T 2026-11-23 4:25）。読むだけで返金は作らない。注文を読む前に決めるので、返金の計上ロケーションの
  // メタフィールドもこのあとの取得に入る。決められなかったものは pending のまま、下の assert で止まる。
  try {
    await autoResolveStalePendingSpecialRefunds(
      admin,
      shopId,
      {
        locationIds: [
          locationId,
          locationId.startsWith("gid://") ? locationId : `gid://shopify/Location/${locIdRaw}`,
          locIdRaw,
        ],
        createdFrom: dayRange.startUtc,
        createdTo: dayRange.endUtc,
      },
      { refreshDailySummary: false },
    );
  } catch (e) {
    console.warn("[settlement] auto-resolve of pending special refunds failed", e);
  }

  const attributionCtx = await loadRefundAggregationContext(shopId);

  // 精算の注文境界（D1 / BUSINESS_RULES §1）:
  // - 絞り込みは location_id（数値）+ 日付レンジ + tag_not:settlement のみ
  // - source_name:pos は付けない（注文検索ピッカーとは意図的に異なる）
  // - retailLocation 二次フィルタもメイン集計では行わない（GAS fetchAllOrdersSmart 同型）
  const qCreated   = `location_id:${locIdRaw} ${searchDateRange("created_at", dayRange.startUtcIso, dayRange.endUtcIso)} tag_not:settlement -status:cancelled`;
  const qUpdated   = `location_id:${locIdRaw} ${searchDateRange("updated_at", dayRange.startUtcIso, dayRange.endUtcIso)} tag_not:settlement -status:cancelled`;
  const qCancelled = `location_id:${locIdRaw} ${searchDateRange("updated_at", dayRange.startUtcIso, dayRange.endUtcIso)} tag_not:settlement status:cancelled`;
  // 販売店舗とは別の店舗で処理した返金も拾う。後段で対象店舗の返金 TX のみに
  // 縮約してから union するため、他店舗の売上は混入しない。
  // 値は二重引用符で囲む（囲まないと時刻が効かず前の日の注文が混ざる。shopifySearchDate.ts）
  const qRefundUpdated = `${searchDateRange("updated_at", dayRange.startUtcIso, dayRange.endUtcIso)} tag_not:settlement`;

  const createdRaw   = await fetchAllOrders(admin, qCreated, "CREATED_AT");
  await sleep(GRAPHQL_PAGE_DELAY_MS);
  const updatedRaw   = await fetchAllOrders(admin, qUpdated, "UPDATED_AT");
  await sleep(GRAPHQL_PAGE_DELAY_MS);
  const cancelledRaw = await fetchAllOrders(admin, qCancelled, "UPDATED_AT");
  await sleep(GRAPHQL_PAGE_DELAY_MS);
  const includeCrossLocationRefunds =
    attributionCtx.mode === "refund_transaction_pos_location";
  const refundUpdatedRaw =
    includeCrossLocationRefunds
      ? await fetchAllOrders(admin, qRefundUpdated, "UPDATED_AT")
      : [];
  if (includeCrossLocationRefunds) {
    await sleep(GRAPHQL_PAGE_DELAY_MS);
  }

  const inDay = (iso?: string) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime();
  };

  let ordersUnion = unionSettlementOrdersById(
    unionSettlementOrdersById(createdRaw, updatedRaw),
    cancelledRaw,
  );
  // 店舗の取得に入っている注文は足さない（売上を持つ元の注文を返金だけの入力で上書きしない）
  ordersUnion = mergeCrossLocationRefundOrders(
    ordersUnion,
    refundUpdatedRaw,
    inDay,
    locationId,
    locIdRaw,
    attributionCtx,
  );

  // GAS fetchAllOrdersSmart ③: 0件のとき processed_at（店舗TZの暦日）でフォールバック
  if (ordersUnion.length === 0) {
    const processedRange = getDayRangeShopifySearchIso(targetDate, timezone);
    const qProcessed = `location_id:${locIdRaw} ${searchDateRange("processed_at", processedRange.start, processedRange.end)} tag_not:settlement -status:cancelled`;
    const processedRaw = await fetchAllOrders(admin, qProcessed, "CREATED_AT");
    ordersUnion = processedRaw.filter((o) => {
      if (!o.processedAt) return false;
      const t = new Date(o.processedAt).getTime();
      return t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime();
    });
  }

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

  // ポイント利用額に数える割引（旧 VIP の VIP-・Shop Point の SP-POINT- と旧形式・POS の「Shop Point」）。
  // 「ポイント/会員施策設定」で変えられる。保存していない店は初めの値。
  const loyaltySettings = await getAppSetting<Partial<LoyaltySettings>>(shopId, LOYALTY_SETTINGS_KEY);
  const pointRules = resolvePointRedemptionRules(loyaltySettings);

  const voucherSettings = resolveVoucherSettings(
    await getAppSetting<Partial<VoucherSettings> & { settingsVersion?: number }>(shopId, VOUCHER_SETTINGS_KEY),
    DEFAULT_VOUCHER_SETTINGS,
  );
  // 精算の数え方（売上を数える日・返金の支払方法の変更・点数に数えない SKU など）。保存していない店は今の数え方
  const calcSettings = resolveSettlementCalcSettings(
    await getAppSetting<unknown>(shopId, SETTLEMENT_CALC_SETTINGS_KEY),
  );

  // 支払方法の分け方。初めは決まった分け方（今の動き）。マスタで分ける店だけマスタを読む
  const paymentKey = paymentKeyResolverFor(
    calcSettings.paymentKeySource,
    calcSettings.paymentKeySource === "master" ? await loadPaymentKeyMasters(shopId) : [],
  );

  const gas = aggregateGasStyleForOrders(ordersUnion, inDay, attributionOpts, pointRules, {
    saleDateBasis: calcSettings.saleDateBasis,
    itemCountExcludedSkuKeys: new Set(calcSettings.itemCountExcludedSkus),
    refundRemapRules: calcSettings.refundRemapRules,
    locIdRaw,
    paymentKey,
  }, voucherDetectionRulesFromSettings(voucherSettings));

  const settlementSettings = await getAppSetting<Partial<SettlementSettings>>(shopId, SETTLEMENT_SETTINGS_KEY);
  const settlementMerged: SettlementSettings = { ...DEFAULT_SETTLEMENT_SETTINGS, ...settlementSettings };

  const legacyGiftOn = settlementMerged.legacyGiftCardAggregationEnabled === true;
  let legacyGiftCardsAddedAmount = 0;
  let legacyGiftCardsAddedCount = 0;
  if (legacyGiftOn) {
    const posOrderIds = new Set(ordersUnion.map((o) => o.id));
    // 取得が途中で失敗したら UpstreamAggregationError / ThrottledExhaustedError がそのまま上がる。
    // 以前は握りつぶして 0 円のまま精算を確定していた（商品券の売上が欠ける）。#16 と同じく確定しない。
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
      const bucket = paymentKey("gift_card", null).key;
      ensurePayBucket(gas.pay, bucket);
      gas.pay[bucket].sale += leg.amount;
      gas.pay[bucket].saleTx += leg.count;
    }
  }

  // ギフトカードで払い出した返金（「精算の数え方」で ON の店だけ）。読めなければ精算を止める
  // 旧ギフトカード API 集計が ON のあいだは数えない（返金のカードが売上にも足されて二重になるため。
  // 「精算の数え方」の画面は保存で断るが、あとから精算設定で旧集計を ON にした店もここで守る）
  let giftCardRefundAmount = 0;
  let giftCardRefundCount = 0;
  const giftCardRefundOn = calcSettings.giftCardRefundEnabled && !legacyGiftOn;
  if (giftCardRefundOn) {
    const locRow = await prisma.location.findFirst({
      where: { shopId, shopifyLocationGid: { in: [locationId, `gid://shopify/Location/${locIdRaw}`] } },
      select: { name: true, displayName: true, shortName: true },
    });
    const gc = await fetchGiftCardRefundsForDay(admin, {
      targetDate,
      dayRange,
      locationNames: [locationName, locRow?.name, locRow?.displayName, locRow?.shortName].filter(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      ),
    });
    giftCardRefundAmount = gc.amount;
    giftCardRefundCount = gc.count;
    if (gc.amount > 0) {
      const bucket = calcSettings.giftCardRefundLabel;
      ensurePayBucket(gas.pay, bucket);
      gas.pay[bucket].refund += gc.amount;
      gas.pay[bucket].refundTx += gc.count;
      gas.refundsGross += gc.amount;
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
  // DB は「日・店 → 注文」の目次。数える日（countDate）がこの日の行と、前からの行（countDate なし）は登録した日で探す。
  // 数そのものは注文メタフィールド pos.adjustments から読む（docs/ORDER_ADJUSTMENTS_METAFIELD.md）。
  const specialRefundIndexRows = await prisma.specialRefundEvent.findMany({
    where: {
      shopId,
      locationId: { in: [locationId, locationGid, locIdRaw] },
      status: "active",
      OR: [
        { countDate: targetDate },
        {
          countDate: null,
          createdAt: {
            gte: dayRange.startUtc,
            lte: dayRange.endUtc,
          },
        },
      ],
    },
  });
  // 数えるのはアプリの記録（DB）。注文に書く設定の店は、注文の値と比べ、違う・無い・読めない注文を書き直す
  // （T の決定 2026-11-23。docs/ORDER_ADJUSTMENTS_METAFIELD.md 4 章）
  const metafieldEnabled =
    specialRefundIndexRows.length > 0 && (await isOrderAdjustmentsMetafieldEnabled(shopId));
  // 読むのは、注文に書く設定にしてから書いた注文だけ（前からの登録は管理画面から書く。精算ではまとめて書かない）
  const writtenOrderIds = [...groupAdjustmentRowsByOrder(specialRefundIndexRows).values()]
    .filter((rows) => isOrderWrittenSinceSwitch(rows))
    .map((rows) => rows[0].sourceOrderId);
  const adjustmentDocs = metafieldEnabled
    ? await fetchOrderAdjustmentDocs(admin, writtenOrderIds)
    : { fetched: false, docs: new Map<string, string | null>() };
  const {
    events: specialRefundEvents,
    needsResync,
    warnings: adjustmentDiffersAgain,
    notWrittenOrderCount,
  } = resolveSettlementAdjustments({
    date: targetDate,
    locationGid,
    dbRows: specialRefundIndexRows,
    docs: adjustmentDocs.docs,
    docsFetched: adjustmentDocs.fetched,
    recentlyRewritten: recentlyRewrittenOrders(shopId, Date.now()),
  });
  const adjustmentSourceWarnings: AdjustmentSourceWarning[] = [...adjustmentDiffersAgain];
  const rowsByOrder = groupAdjustmentRowsByOrder(specialRefundIndexRows);
  for (const [i, need] of needsResync.entries()) {
    // 1 回の精算で書き直すのは決まった数まで（残りは警告にして、次に開いたときに書き直す）
    // 調べるだけの呼び出し（resyncOrderAdjustments: false）は書かない
    if (opts?.resyncOrderAdjustments === false || i >= MAX_ADJUSTMENT_RESYNC_PER_PREVIEW) {
      adjustmentSourceWarnings.push(need);
      continue;
    }
    const orderGid = toOrderGid(need.sourceOrderId);
    const r = await syncOrderAdjustmentsMetafield(admin, shopId, need.sourceOrderId);
    if (!r.ok) {
      adjustmentSourceWarnings.push(need);
      continue;
    }
    recentAdjustmentRewrites.set(`${shopId}|${orderGid}`, Date.now());
    // 書いたあとに注文を読み直して、まだ違えば知らせる（ほかのアプリが書き換えている）
    const reread = await fetchOrderAdjustmentDocs(admin, [orderGid]);
    const still = reread.fetched
      ? orderDocMismatch({
          date: targetDate,
          locationGid,
          rows: rowsByOrder.get(orderGid) ?? [],
          raw: reread.docs.get(orderGid) ?? null,
        })
      : null;
    if (still) {
      adjustmentSourceWarnings.push({ ...need, reason: "metafield_differs_again" });
    }
  }
  if (metafieldEnabled && !adjustmentDocs.fetched) {
    console.warn(
      `[settlement] order adjustments metafield read failed; counted from DB shop=${shopId} location=${locationId} date=${targetDate}`,
    );
  }
  if (needsResync.length > 0 || adjustmentDiffersAgain.length > 0 || notWrittenOrderCount > 0) {
    console.warn(
      `[settlement] order adjustments metafield resync count=${needsResync.length} warned=${adjustmentSourceWarnings.length} notWrittenYet=${notWrittenOrderCount} reasons=${[...needsResync, ...adjustmentDiffersAgain].map((w) => w.reason).join(",")} shop=${shopId} location=${locationId} date=${targetDate}`,
    );
  }

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

  // 商品券設定（機能・自動判定・手動調整・判定優先順位・精算に反映）と特殊返金設定「商品券調整を精算に反映」を合わせる。
  // 同じ注文に自動判定と手入力の両方があるときは、判定優先順位の方だけを数える（二重計上の防止）。
  const voucherResolution = resolveVoucherChange({
    settings: voucherSettings,
    reflectManualFromSpecialRefundSettings: srSettings.reflectVoucherAdjustmentToSettlement,
    autoByOrder: gas.voucherChangeByOrder,
    manualEvents: voucherAdjustmentsAll,
    cashCapByOrder: gas.voucherCashCapByOrder,
  });
  const voucherAdjustments = voucherAdjustmentsAll.filter((e) =>
    voucherResolution.appliedManual.includes(e),
  );
  const otherEventsReflected = otherEventsAll.filter((e) => {
    if (e.eventType === "cash_refund") return srSettings.reflectCashRefundToSettlement;
    if (e.eventType === "payment_method_override") {
      return srSettings.reflectPaymentOverrideToSettlement;
    }
    if (e.eventType === "receipt_cash_adjustment") {
      return srSettings.reflectReceiptCashAdjustmentToSettlement;
    }
    return true;
  });
  // 管理者の承認（設定でオンのときの付け替えだけ）: 承認待ち・却下は数えない。
  // 売上サマリーも buildSettlementPreview を通るので同じになる。
  // Shopify 返金の成否が分からない（pending）ものは、承認待ちでも Shopify 側に返金がありうるので下の確認には含める。
  const { counted: otherEvents, awaitingApproval: awaitingApprovalEvents } =
    partitionSpecialRefundEventsByApproval(otherEventsReflected);

  // 精算に入る特殊返金で Shopify 返金の成否が分からないもの（pending）があれば確定しない。
  // 数えると Shopify の返金と上乗せの二重、数えないと返金の抜けになりうるため（監査 P1-1）。
  // 反映の設定がオフの種別は上乗せしないので止めない。
  // 確定しない読み方（プレビュー・点検）は止めずに、注文の一覧を返して警告を出す
  // （T の決定 2026-11-23 4:25「返金処理中の日の点検は警告つきで出す」）。pending は上乗せも振替もしない。
  let pendingSpecialRefundOrderLabels: string[] | undefined;
  if (opts?.allowPendingSpecialRefunds) {
    try {
      assertNoPendingSpecialRefunds(otherEventsReflected);
    } catch (err) {
      if (!(err instanceof SpecialRefundPendingError)) throw err;
      pendingSpecialRefundOrderLabels = err.orderLabels;
    }
  } else {
    assertNoPendingSpecialRefunds(otherEventsReflected);
  }

  /** 自動判定（GAS _voucher_change_total と同系）＋ DB の手入力調整。同じ注文は片方だけ */
  const voucherChangeAmount = voucherResolution.total;
  /** lineItems のポイント利用の割引（pointRules）の按分のみ（特殊返金の points は後続フェーズで合成可） */
  const vipPointsUsed = gas.vipPointsUsed;

  const loyaltyUsageDisplayLabel =
    loyaltySettings?.loyaltyUsageDisplayLabel ?? DEFAULT_LOYALTY_SETTINGS.loyaltyUsageDisplayLabel;

  let paymentSections = await payBucketsToPaymentSections(
    gas.pay,
    shopId,
    calcSettings.paymentTxCountMode,
    calcSettings.paymentKeySource,
  );
  const eventTotals = { total, refundTotal };
  const refundMethodResolver =
    otherEvents.length > 0
      ? await loadRefundMethodResolver(shopId, (m) => paymentKey(m, null).key)
      : undefined;
  const unmatchedRefundMethods = applySpecialRefundEventsToTotals(
    paymentSections,
    otherEvents.map((e) => ({
      eventType: e.eventType,
      amount: e.amount,
      originalPaymentMethod: e.originalPaymentMethod,
      actualRefundMethod: e.actualRefundMethod,
      adjustKind: e.adjustKind,
      shopifyRefundStatus: e.shopifyRefundStatus,
      sourceOrderName: e.sourceOrderName,
    })),
    eventTotals,
    refundMethodResolver && {
      ...refundMethodResolver,
      // マスタで分ける店: 特殊返金の手段（マスタの gateway の名前）を、精算の行の名前に直して探す
      ...(calcSettings.paymentKeySource === "master"
        ? { resolveKey: (m: string) => paymentKey(m, null).key }
        : {}),
    },
  );
  if (unmatchedRefundMethods.length > 0) {
    console.warn(
      `[settlement] special refund method unmatched count=${unmatchedRefundMethods.length} reasons=${unmatchedRefundMethods.map((w) => w.reason).join(",")} shop=${shopId} location=${locationId} date=${targetDate}`,
    );
  }
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
  // 売上に含めない手数料の明細は支払方法別には入ったまま、総売上から引く（BUSINESS_RULES §2.1）
  const nonSalesFeeTotal = roundInt(gas.nonSalesFeeTotal);
  // 返金が売上より多い日: 初めは 0 で止める。「精算の数え方」でマイナスのまま出すこともできる
  total = calcSettings.clampTotalAtZero
    ? Math.max(0, sectionsTotal - nonSalesFeeTotal)
    : sectionsTotal - nonSalesFeeTotal;
  const taxRatePercent = Number(settlementMerged.taxRatePercent) || 10;
  const split =
    total >= 0
      ? splitTaxInclusiveToNetAndTax(total, taxRatePercent)
      : (() => {
          // マイナスのまま出すとき: 税も同じ式でマイナスにする（純売上 = 合計 − 税）
          const t = roundInt((total * taxRatePercent) / (100 + taxRatePercent));
          return { tax: t, netSales: roundInt(total - t) };
        })();
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
    // ギフトカードの返金は注文が無いので 1 枚を 1 件として足す（ciara-system と同じ）
    refundCount: gas.refundOrderSet.size + giftCardRefundCount,
    itemCount,
    voucherChangeAmount: roundInt(voucherChangeAmount),
    voucherChangeBreakdown: {
      autoTotal: voucherResolution.autoTotal,
      manualTotal: voucherResolution.manualTotal,
      skippedAutoAmount: voucherResolution.skippedAutoAmount,
      skippedManualAmount: voucherResolution.skippedManualAmount,
      legacy: voucherResolution.legacy,
      cashDepositDeduction: voucherResolution.cashDepositDeduction,
    },
    paymentSections,
    ...(pendingSpecialRefundOrderLabels ? { pendingSpecialRefundOrderLabels } : {}),
    nonSalesFeeTotal,
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
    ...(giftCardRefundOn ? { giftCardRefundAmount, giftCardRefundCount } : {}),
    ...(awaitingApprovalEvents.length > 0
      ? (() => {
          const items = awaitingApprovalEvents.map((e) => ({
            id: e.id,
            eventType: e.eventType,
            amount: roundInt(Number(e.amount)),
            sourceOrderName: e.sourceOrderName,
          }));
          return {
            awaitingApprovalSpecialRefunds: items,
            awaitingApprovalWarning: awaitingApprovalWarningMessage(items),
          };
        })()
      : {}),
    ...(adjustmentSourceWarnings.length > 0 || (metafieldEnabled && !adjustmentDocs.fetched)
      ? {
          adjustmentSourceWarnings: [
            ...adjustmentSourceWarnings.map((w) => ({
              ...w,
              message: adjustmentSourceWarningMessage(w),
            })),
            ...(metafieldEnabled && !adjustmentDocs.fetched
              ? [
                  {
                    reason: "metafield_unreadable" as const,
                    sourceOrderId: "",
                    sourceOrderName: null,
                    message:
                      "注文の「返金方法変更・商品券釣銭登録」を読めず、注文の記録と比べられませんでした。精算はアプリの記録で数えています。しばらくしてから更新してください。",
                  },
                ]
              : []),
          ],
        }
      : {}),
    ...(unmatchedRefundMethods.length > 0
      ? {
          unmatchedRefundMethods: unmatchedRefundMethods.map((w) => ({
            ...w,
            amount: roundInt(w.amount),
            message: unmatchedRefundWarningMessage(w),
          })),
        }
      : {}),
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
    ...(preview.nonSalesFeeTotal
      ? [`売上に含めない送料等: ¥${preview.nonSalesFeeTotal.toLocaleString()}`]
      : []),
    "─────────────────",
    ...preview.paymentSections.map(
      (s) => `${s.label}: ¥${s.net.toLocaleString()} (${s.txCount}件)${s.refund > 0 ? ` 返金${s.refundCount}件 ¥${s.refund.toLocaleString()}` : ""}`
    ),
  ];
  return lines.join("\n");
}
