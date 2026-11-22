/**
 * GET /api/orders/:orderId
 * 注文詳細（Shopify POS 同等のサマリー）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { ORDER_DETAIL_QUERY, serializeOrderDetail } from "../services/orderDetail.server";
import { isOrderEligibleForRedoDraft } from "../services/orderRedoDraft.server";
import { getPaymentMethodVoucherInfo } from "../utils/paymentMethod.server";
import {
  getAppSetting,
  SPECIAL_REFUND_SETTINGS_KEY,
  DEFAULT_SPECIAL_REFUND_SETTINGS,
  type SpecialRefundSettings,
} from "../utils/appSettings.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    const orderId = params.orderId;
    if (!orderId) {
      return corsJson({ ok: false, error: "orderId required" }, { status: 400 });
    }

    const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

    const response = await admin.graphql(ORDER_DETAIL_QUERY, {
      variables: { id: gid },
    });

    const json = await response.json();
    if (json.errors?.length) {
      return corsJson(
        { ok: false, error: "GraphQL error", details: json.errors },
        { status: 500 },
      );
    }

    const order = json.data?.order;
    if (!order) {
      return corsJson({ ok: false, error: "Order not found" }, { status: 404 });
    }

    const timezone = await getShopTimezoneForDaily(admin, shop.id);
    const result = serializeOrderDetail(order as Record<string, unknown>, { timezone });

    const gateways = ((result.transactions as { gateway?: string }[]) ?? []).map((t) => t.gateway ?? "");
    let hasVoucherChange = false;
    for (const gw of gateways) {
      if (!gw) continue;
      const info = await getPaymentMethodVoucherInfo(shop.id, gw);
      if (info.voucherChangeSupported) {
        hasVoucherChange = true;
        break;
      }
    }
    if (!hasVoucherChange && /商品券/.test(String(result.note ?? ""))) {
      hasVoucherChange = true;
    }

    const srSettingsRaw = await getAppSetting<Partial<SpecialRefundSettings>>(
      shop.id,
      SPECIAL_REFUND_SETTINGS_KEY,
    );
    const srSettings = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...srSettingsRaw };
    const eligible = isOrderEligibleForRedoDraft(
      order as {
        cancelledAt?: string | null;
        displayFinancialStatus?: string | null;
        refunds?: unknown[];
      },
    );

    return corsJson({
      ...result,
      estimatedVoucherChange: hasVoucherChange,
      canRedoAsDraft: srSettings.enableOrderRedoDraft && eligible,
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
