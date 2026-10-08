/**
 * GET /api/print/sales/:orderId
 * 販売レシート HTML（Shopify Printing API の src）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsHtml,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import { getAppSetting } from "../utils/appSettings.server";
import {
  SALES_RECEIPT_SETTINGS_KEY,
  DEFAULT_SALES_RECEIPT_SETTINGS,
  type SalesReceiptSettings,
} from "../utils/salesReceiptSettings";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  SALES_RECEIPT_ORDER_QUERY,
  buildSalesReceiptHtml,
} from "../services/salesReceiptPrint.server";
export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop } = authResult;

    const fullAccess = await getFullAccess(admin, { shop: shop.shopDomain });
    const access = checkPlanAccess(shop.planCode, "sales_receipt", fullAccess);
    if (!access.allowed) {
      return corsHtml(request, `<!DOCTYPE html><html><body><p>${access.message}</p></body></html>`, {
        status: 403,
      });
    }

    const orderId = params.orderId;
    if (!orderId) {
      return corsErrorJson(request, { ok: false, error: "orderId required" }, 400);
    }

    const saved = await getAppSetting<Partial<SalesReceiptSettings>>(
      shop.id,
      SALES_RECEIPT_SETTINGS_KEY,
    );
    const settings: SalesReceiptSettings = {
      ...DEFAULT_SALES_RECEIPT_SETTINGS,
      ...saved,
      layoutJson: {
        ...DEFAULT_SALES_RECEIPT_SETTINGS.layoutJson,
        ...(saved?.layoutJson ?? {}),
      },
    };
    if (!settings.enabled) {
      return corsHtml(
        request,
        `<!DOCTYPE html><html><body><p>販売レシート印字は無効です。</p></body></html>`,
        { status: 403 },
      );
    }

    const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
    const response = await admin.graphql(SALES_RECEIPT_ORDER_QUERY, { variables: { id: gid } });
    const json = (await response.json()) as {
      errors?: unknown[];
      data?: { order?: Record<string, unknown> | null };
    };
    if (json.errors?.length || !json.data?.order) {
      return corsHtml(
        request,
        `<!DOCTYPE html><html><body><p>注文が見つかりません。</p></body></html>`,
        { status: 404 },
      );
    }

    const timezone = await getShopTimezoneForDaily(admin, shop.id);
    const html = buildSalesReceiptHtml(json.data.order, settings, {
      timezone,
      shopName: settings.headerTitle || undefined,
    });
    return corsHtml(request, html);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
