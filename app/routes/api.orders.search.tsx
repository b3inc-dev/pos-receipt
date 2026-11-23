/**
 * GET /api/orders/search
 * 要件書 21.2: 注文検索（部分一致・日付・ロケーション・ページング）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import {
  formatTimeHmInTimeZone,
  getCalendarDateStringInTimeZone,
  getDayRangeInUtc,
  getShopTimezoneForDaily,
} from "../utils/shopTimezone.server";
import { buildSearchQuery, normalizeLocationIdForQuery } from "../utils/orderSearchQuery";
import { hasVoucherLikeGatewayHeuristic, matchPaymentMethodMaster } from "../utils/paymentMethodMatch.server";
import { graphqlWithCustomerFallback } from "../utils/protectedCustomerData";
import { isShopifyRefundPending } from "../services/specialRefundOverlayPure.server";
import { pickOrdersRefundedAtLocation, type RefundedAtLocationOrder } from "../utils/ordersRefundedAtLocation";

const ORDERS_SEARCH_QUERY_TEMPLATE = `#graphql
  query OrdersSearch($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        cancelledAt
        note
        totalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        __CUSTOMER__
        retailLocation {
          id
          name
        }
        transactions(first: 20) {
          gateway
          formattedGateway
          kind
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ORDERS_SEARCH_QUERY = ORDERS_SEARCH_QUERY_TEMPLATE.replace("__CUSTOMER__", "customer { displayName }");
/** 顧客の名前を読まない版（保護された顧客データの「名前」の許可が無いアプリ用） */
const ORDERS_SEARCH_QUERY_NO_CUSTOMER = ORDERS_SEARCH_QUERY_TEMPLATE.replace("__CUSTOMER__", "");

/**
 * ほかの店舗で売って、この店舗で返品した注文を探す（その日に更新された注文の返金の取引の店を見る）。
 * 精算の「返品があった店で集計」と同じ探し方（settlementEngine の qRefundUpdated）
 */
const ORDERS_REFUNDED_AT_LOCATION_QUERY_TEMPLATE = `#graphql
  query OrdersRefundedAtLocation($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        cancelledAt
        note
        totalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        __CUSTOMER__
        retailLocation { id name }
        transactions(first: 20) { gateway formattedGateway kind }
        refunds {
          createdAt
          transactions(first: 20) { nodes { kind location { id } } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const ORDERS_REFUNDED_AT_LOCATION_QUERY = ORDERS_REFUNDED_AT_LOCATION_QUERY_TEMPLATE.replace(
  "__CUSTOMER__",
  "customer { displayName }",
);
const ORDERS_REFUNDED_AT_LOCATION_QUERY_NO_CUSTOMER = ORDERS_REFUNDED_AT_LOCATION_QUERY_TEMPLATE.replace(
  "__CUSTOMER__",
  "",
);
/** 1 日に読む上限（多すぎる日は先頭の分だけ。精算は別に全部読む） */
const REFUNDED_AT_LOCATION_MAX_PAGES = 4;

function normalizeOrderIdKey(id: string): string {
  return String(id).replace(/^gid:\/\/shopify\/Order\//, "");
}

function isRefundedFinancialStatus(status: string | null | undefined): boolean {
  const s = String(status || "").toUpperCase();
  return s === "REFUNDED" || s === "PARTIALLY_REFUNDED";
}


function gatewaysFromTransactions(
  txs: Array<{ gateway?: string | null; formattedGateway?: string | null }>,
): string[] {
  return txs.map((t) => String(t.gateway ?? "").trim()).filter(Boolean);
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    const locationId = url.searchParams.get("locationId");
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const cursor = url.searchParams.get("cursor");
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));

    const timezone = await getShopTimezoneForDaily(admin, shop.id);
    const masters = await prisma.paymentMethodMaster.findMany({
      where: { shopId: shop.id, enabled: true },
      orderBy: { sortOrder: "asc" },
    });

    const query = buildSearchQuery({ q, locationId, dateFrom, dateTo, timezone });

    const variables = { first: limit, after: cursor || null, query: query || null };
    // 保護された顧客データ（名前）の許可が無いアプリでは、名前なしで読み直す
    const json = await graphqlWithCustomerFallback(admin, ORDERS_SEARCH_QUERY, ORDERS_SEARCH_QUERY_NO_CUSTOMER, variables);
    if (json.errors?.length) {
      return corsJson(
        { ok: false, error: "GraphQL error", details: json.errors },
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo ?? {};

    // ほかの店舗で売って、この店舗で返品した注文（日付の一覧の 1 ページ目だけ足す。検索・続きの読み込みでは足さない）
    let refundedHere: RefundedAtLocationOrder[] = [];
    const locRawForRefund = normalizeLocationIdForQuery(locationId);
    if (locRawForRefund && !q?.trim() && !cursor && dateFrom && dateTo) {
      try {
        const start = getDayRangeInUtc(dateFrom, timezone).startUtcIso;
        const end = getDayRangeInUtc(dateTo, timezone).endUtcIso;
        // 返金のある注文だけ（その日に更新）。販売店で絞らず、返金の取引の店で選ぶ
        const refundQuery = `updated_at:>="${start}" AND updated_at:<="${end}" AND (financial_status:refunded OR financial_status:partially_refunded)`;
        const found: Record<string, unknown>[] = [];
        let after: string | null = null;
        for (let page = 0; page < REFUNDED_AT_LOCATION_MAX_PAGES; page++) {
          const r = await graphqlWithCustomerFallback(
            admin,
            ORDERS_REFUNDED_AT_LOCATION_QUERY,
            ORDERS_REFUNDED_AT_LOCATION_QUERY_NO_CUSTOMER,
            { first: 50, after, query: refundQuery },
          );
          if (r.errors?.length) break;
          found.push(...((r.data?.orders?.nodes ?? []) as Record<string, unknown>[]));
          if (!r.data?.orders?.pageInfo?.hasNextPage) break;
          after = r.data.orders.pageInfo.endCursor ?? null;
          if (!after) break;
        }
        refundedHere = pickOrdersRefundedAtLocation(found as RefundedAtLocationOrder[], locRawForRefund, start, end);
      } catch (e) {
        // 読めなくても、この店舗で売った注文の一覧は出す
        console.warn("[orders/search] refunded-at-location read failed", e);
      }
    }
    const refundedHereIds = new Set(refundedHere.map((o) => o.id));

    let items = [...nodes, ...refundedHere.filter((o) => !nodes.some((n: { id?: string }) => n.id === o.id))].map((node: Record<string, unknown>) => {
      const n = node as {
        id: string;
        name: string;
        createdAt: string;
        cancelledAt?: string | null;
        note?: string | null;
        displayFinancialStatus?: string | null;
        totalPriceSet?: { shopMoney?: { amount?: string } };
        customer?: { displayName?: string } | null;
        retailLocation?: { id: string; name: string } | null;
        transactions?: Array<{ gateway?: string | null; formattedGateway?: string | null }>;
      };
      const gateways = gatewaysFromTransactions(n.transactions ?? []);
      const financialStatus = n.displayFinancialStatus ?? "";
      const isCancelled = Boolean(n.cancelledAt);
      const isRefunded = isRefundedFinancialStatus(financialStatus);
      const voucherLike = hasVoucherLikeGatewayHeuristic(gateways, masters);
      const hasVoucherChange =
        gateways.some((gw) => matchPaymentMethodMaster(gw, masters)?.voucherChangeSupported) ||
        /商品券/.test(String(n.note ?? ""));

      return {
        orderId: n.id?.replace("gid://shopify/Order/", "") ?? n.id,
        orderName: n.name,
        customerName: n.customer?.displayName ?? "",
        locationId: n.retailLocation?.id ?? "",
        locationName: n.retailLocation?.name ?? "",
        totalPrice: n.totalPriceSet?.shopMoney?.amount ?? "0",
        currency: "JPY",
        createdAt: n.createdAt,
        transactionTime: n.createdAt ? formatTimeHmInTimeZone(n.createdAt, timezone) : "",
        // 一覧の「今日 18:14」「11月20日 19:04」用。店のタイムゾーンの暦日（日本の店は日本時間）
        localDate: n.createdAt ? getCalendarDateStringInTimeZone(new Date(n.createdAt), timezone) : "",
        financialStatus,
        segmentFlags: {
          isCancelled,
          isRefunded,
          hasVoucherChange,
          hasVoucherLike: voucherLike,
        },
        posBadges: {
          otherStoreSale: refundedHereIds.has(n.id),
          refundedShopify: isRefunded,
          cancelled: isCancelled,
          voucherLikeGateway: voucherLike,
          hasVoucherChange,
          hasVoucherAdjustment: false,
          receiptIssued: false,
          hasSpecialRefund: false,
          appSpecialApplied: false,
          hasPendingShopifyRefund: false,
        },
      };
    });

    const requestedLocRaw = normalizeLocationIdForQuery(locationId);
    if (requestedLocRaw) {
      const locationGid = `gid://shopify/Location/${requestedLocRaw}`;
      items = items.filter((item) => {
        if (item.posBadges.otherStoreSale) return true;
        const rid = item.locationId?.trim();
        if (!rid) return false;
        return rid === locationGid || rid === requestedLocRaw || rid.endsWith(`/${requestedLocRaw}`);
      });
    }

    const idKeys = items.map((item) => normalizeOrderIdKey(item.orderId));
    if (idKeys.length > 0) {
      const [receiptRows, eventRows] = await Promise.all([
        prisma.receiptIssue.findMany({
          where: { shopId: shop.id, orderId: { in: idKeys } },
          select: { orderId: true },
        }),
        prisma.specialRefundEvent.findMany({
          // 登録の注文 ID は数字のときと GID のときがある（どちらでも拾う）
          where: {
            shopId: shop.id,
            sourceOrderId: { in: [...idKeys, ...idKeys.map((k) => `gid://shopify/Order/${k}`)] },
            // 無効化した登録も読む（有効な登録が無く無効化だけの注文に「登録を無効化」の印を付ける）
            status: { in: ["active", "voided"] },
          },
          select: { sourceOrderId: true, eventType: true, shopifyRefundStatus: true, status: true, approvalStatus: true },
        }),
      ]);
      const receiptSet = new Set(receiptRows.map((r) => normalizeOrderIdKey(r.orderId)));
      const eventsByOrder = new Map<string, string[]>();
      // Shopify 返金の結果が分かっていない（pending）登録がある注文。精算を止めるので一覧で分かるようにする
      const pendingOrders = new Set<string>();
      const voidedOrders = new Set<string>();
      const approvalPendingOrders = new Set<string>();
      for (const e of eventRows) {
        const oid = normalizeOrderIdKey(e.sourceOrderId);
        if (e.status === "voided") {
          voidedOrders.add(oid);
          continue;
        }
        if (e.approvalStatus === "pending") approvalPendingOrders.add(oid);
        if (!eventsByOrder.has(oid)) eventsByOrder.set(oid, []);
        eventsByOrder.get(oid)!.push(e.eventType);
        if (isShopifyRefundPending(e.shopifyRefundStatus)) pendingOrders.add(oid);
      }
      items = items.map((item) => {
        const oid = normalizeOrderIdKey(item.orderId);
        const types = eventsByOrder.get(oid) ?? [];
        const hasSpecialRefund = types.some((t) => t !== "voucher_change_adjustment");
        const hasVoucherAdjustment = types.includes("voucher_change_adjustment");
        return {
          ...item,
          posBadges: {
            ...item.posBadges,
            receiptIssued: receiptSet.has(oid),
            hasSpecialRefund,
            hasVoucherAdjustment,
            appSpecialApplied: hasSpecialRefund,
            hasPendingShopifyRefund: pendingOrders.has(oid),
            hasApprovalPending: approvalPendingOrders.has(oid),
            // 有効な登録が無く、無効化した登録だけがある
            onlyVoidedAdjustments: types.length === 0 && voidedOrders.has(oid),
          },
        };
      });
    }

    return corsJson(
      {
        items,
        nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
        timezone,
        // 一覧の「今日」の判定と「18:14 に更新」用（店のタイムゾーン）。端末の時計には頼らない
        todayLocalDate: getCalendarDateStringInTimeZone(new Date(), timezone),
        fetchedAtTime: formatTimeHmInTimeZone(new Date().toISOString(), timezone),
        searchMode: Boolean(q?.trim()),
      },
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
