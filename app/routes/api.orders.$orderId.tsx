/**
 * GET /api/orders/:orderId
 * 要件書 21.2: 注文詳細（core, transactions, refunds, customer, location, line items）
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson } from "../utils/posAuth.server";

const ORDER_DETAIL_QUERY = `#graphql
  query OrderDetail($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      customer {
        id
        displayName
        email
      }
      location {
        id
        name
      }
      lineItems(first: 100) {
        nodes {
          id
          title
          quantity
          originalUnitPriceSet { shopMoney { amount } }
          discountedUnitPriceSet { shopMoney { amount } }
        }
      }
      transactions(first: 50) {
        id
        kind
        status
        gateway
        amountSet { shopMoney { amount currencyCode } }
        createdAt
      }
      refunds {
        id
        createdAt
        totalRefundedSet { shopMoney { amount } }
      }
    }
  }
`;

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, corsJson } = authResult;
    const orderId = params.orderId;
    if (!orderId) {
      return corsJson(
        { ok: false, error: "orderId required" },
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

    const response = await admin.graphql(ORDER_DETAIL_QUERY, {
      variables: { id: gid },
    });

    const json = await response.json();
    if (json.errors?.length) {
      return corsJson(
        { ok: false, error: "GraphQL error", details: json.errors },
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const order = json.data?.order;
    if (!order) {
      return corsJson(
        { ok: false, error: "Order not found" },
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const result = {
      orderId: order.id?.replace("gid://shopify/Order/", "") ?? order.id,
      orderName: order.name,
      createdAt: order.createdAt,
      financialStatus: order.displayFinancialStatus,
      totalPrice: order.totalPriceSet?.shopMoney ?? {},
      customer: order.customer
        ? {
            id: order.customer.id,
            displayName: order.customer.displayName,
            email: order.customer.email,
          }
        : null,
      location: order.location
        ? { id: order.location.id, name: order.location.name }
        : null,
      lineItems: (order.lineItems?.nodes ?? []).map((li: Record<string, unknown>) => ({
        id: li.id,
        title: li.title,
        quantity: li.quantity,
        originalUnitPrice: (li.originalUnitPriceSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount,
        discountedUnitPrice: (li.discountedUnitPriceSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount,
      })),
      transactions: (order.transactions ?? []).map((tx: Record<string, unknown>) => ({
        id: tx.id,
        kind: tx.kind,
        status: tx.status,
        gateway: tx.gateway,
        amount: (tx.amountSet as { shopMoney?: { amount?: string; currencyCode?: string } })?.shopMoney,
        createdAt: tx.createdAt,
      })),
      refunds: (order.refunds ?? []).map((r: Record<string, unknown>) => ({
        id: r.id,
        createdAt: r.createdAt,
        totalRefunded: (r.totalRefundedSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount,
      })),
    };

    return corsJson(result, {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
