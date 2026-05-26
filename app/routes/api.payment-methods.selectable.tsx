/**
 * GET /api/payment-methods/selectable
 * POS 特殊返金フォーム用の支払方法一覧（マスタ正本）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { syncPaymentMethodsFromRecentOrders } from "../services/paymentMethodSync.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const url = new URL(request.url);
    const sync = url.searchParams.get("sync") === "1";

    if (sync) {
      try {
        await syncPaymentMethodsFromRecentOrders(admin, shop.id, 90);
      } catch {
        // 同期失敗でも一覧は返す
      }
    }

    const items = await prisma.paymentMethodMaster.findMany({
      where: { shopId: shop.id, enabled: true, selectableForSpecialRefund: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    return corsJson({
      items: items.map((m) => ({
        id: m.id,
        value: m.rawGatewayPattern,
        label: m.displayLabel,
        category: m.category,
        isVoucher: m.isVoucher,
        voucherChangeSupported: m.voucherChangeSupported,
      })),
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
