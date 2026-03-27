/**
 * GET /api/orders/:orderId
 * 要件書 21.2: 注文詳細（core, transactions, refunds, customer, location, line items）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";

const ORDER_DETAIL_QUERY = `#graphql
  query OrderDetail($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      retailLocation {
        id
        name
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
      customer: null,
      location: order.retailLocation
        ? { id: order.retailLocation.id, name: order.retailLocation.name }
        : null,
      lineItems: [],
      transactions: [],
      refunds: [],
    };

    return corsJson(result, {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
