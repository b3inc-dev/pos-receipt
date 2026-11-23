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
  getShopTimezoneForDaily,
} from "../utils/shopTimezone.server";
import { buildSearchQuery, normalizeLocationIdForQuery } from "../utils/orderSearchQuery";
import { hasVoucherLikeGatewayHeuristic, matchPaymentMethodMaster } from "../utils/paymentMethodMatch.server";
import { isShopifyRefundPending } from "../services/specialRefundOverlayPure.server";

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
 * 保護された顧客データ（名前など）の許可が無いと、Shopify は問い合わせ全体をエラーにする
 * （例: "This app is not approved to use the displayName field. See .../protected-customer-data"）。
 * そのときは名前なしで読み直し、一覧は番号だけで出す（2026-11-23 開発ストアの実機で 11/20 の一覧が出なかった）。
 */
export function isProtectedCustomerDataError(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const msg = String((e as { message?: unknown })?.message ?? "");
    return /protected-customer-data|not approved to use/i.test(msg);
  });
}

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
    // admin.graphql は GraphQL のエラーで例外を投げることも、errors を返すこともある。どちらでも名前なしで読み直す
    let json: { data?: any; errors?: unknown[] };
    try {
      const response = await admin.graphql(ORDERS_SEARCH_QUERY, { variables });
      json = await response.json();
      if (json.errors?.length && isProtectedCustomerDataError(json.errors)) {
        throw Object.assign(new Error("protected customer data"), { errors: json.errors });
      }
    } catch (e) {
      const errs = (e as { body?: { errors?: unknown } })?.body?.errors ?? (e as { errors?: unknown })?.errors;
      const msg = e instanceof Error ? e.message : String(e);
      const blocked =
        isProtectedCustomerDataError(Array.isArray(errs) ? errs : (errs as { graphQLErrors?: unknown[] })?.graphQLErrors) ||
        isProtectedCustomerDataError([{ message: msg }]);
      if (!blocked) throw e;
      const response = await admin.graphql(ORDERS_SEARCH_QUERY_NO_CUSTOMER, { variables });
      json = await response.json();
    }
    if (json.errors?.length) {
      return corsJson(
        { ok: false, error: "GraphQL error", details: json.errors },
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo ?? {};

    let items = nodes.map((node: Record<string, unknown>) => {
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
