/**
 * POST /api/admin/payment-methods/sync
 * 管理画面: 直近90日の取引から支払方法マスタを自動登録
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { syncPaymentMethodsFromRecentOrders } from "../services/paymentMethodSync.server";

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const shop = await resolveShop(session.shop, admin);
  const result = await syncPaymentMethodsFromRecentOrders(admin, shop.id, 90);

  return Response.json({ ok: true, ...result });
}
