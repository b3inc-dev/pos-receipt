/**
 * GET /api/orders/search
 * 要件書 21.2: 注文検索（部分一致・日付・ロケーション・ページング）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { formatTimeHmInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { buildSearchQuery, normalizeLocationIdForQuery } from "../utils/orderSearchQuery";
import { hasVoucherLikeGatewayHeuristic, matchPaymentMethodMaster } from "../utils/paymentMethodMatch.server";
import { isShopifyRefundPending } from "../services/specialRefundOverlayPure.server";

const ORDERS_SEARCH_QUERY = `#graphql
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
        customer {
          displayName
        }
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

    const response = await admin.graphql(ORDERS_SEARCH_QUERY, {
      variables: { first: limit, after: cursor || null, query: query || null },
    });

    const json = await response.json();
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
            status: "active",
          },
          select: { sourceOrderId: true, eventType: true, shopifyRefundStatus: true },
        }),
      ]);
      const receiptSet = new Set(receiptRows.map((r) => normalizeOrderIdKey(r.orderId)));
      const eventsByOrder = new Map<string, string[]>();
      // Shopify 返金の結果が分かっていない（pending）登録がある注文。精算を止めるので一覧で分かるようにする
      const pendingOrders = new Set<string>();
      for (const e of eventRows) {
        const oid = normalizeOrderIdKey(e.sourceOrderId);
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
          },
        };
      });
    }

    return corsJson(
      {
        items,
        nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
        timezone,
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
