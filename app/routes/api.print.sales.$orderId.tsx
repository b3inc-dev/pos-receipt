/**
 * GET /api/print/sales/:orderId
 * 販売レシート HTML（Shopify Printing API の src）
 * 通常の Shopify 販売注文そのものは作らない。帳票 HTML のみ。
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
import { GIFT_ORDER_QUERY, giftOrderHtml } from "../services/giftOrderReceipt";

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
    const copy = new URL(request.url).searchParams.get("copy");
    if (copy === "gift") {
      const html = await giftOrderHtml(async (after) => {
        const response = await admin.graphql(GIFT_ORDER_QUERY, { variables: { id: gid, after } });
        const result = await response.json();
        if (!response.ok || result.errors?.length) throw new Error("ギフトレシートの明細を取得できませんでした。");
        return result.data?.order ?? null;
      }, settings.paperWidthMm === 58 ? 58 : 80);
      if (html === null) return corsErrorJson(request, { ok: false, error: "注文が見つかりません。" }, 404);
      return corsHtml(request, html);
    }
    if (copy !== null) return corsErrorJson(request, { ok: false, error: "帳票種別が無効です。" }, 400);
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
