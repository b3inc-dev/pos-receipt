/**
 * GET  /api/settings/payment-methods — 支払方法マスタ一覧取得
 * POST /api/settings/payment-methods — 新規作成
 * 要件 §6, §13.3
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const list = await prisma.paymentMethodMaster.findMany({
    where: { shopId: shop.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return Response.json({ items: list });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = (await request.json()) as {
    id?: string;
    rawGatewayPattern: string;
    formattedGatewayPattern?: string | null;
    matchType?: string;
    displayLabel: string;
    category?: string;
    sortOrder?: number;
    isVoucher?: boolean;
    voucherChangeSupported?: boolean;
    voucherNoChangeSupported?: boolean;
    selectableForSpecialRefund?: boolean;
    selectableForReceiptCashAdjustment?: boolean;
    selectableForPaymentOverride?: boolean;
    enabled?: boolean;
  };

  const rawGatewayPattern = String(body.rawGatewayPattern ?? "").trim();
  const displayLabel = String(body.displayLabel ?? "").trim();
  if (!rawGatewayPattern || !displayLabel) {
    return Response.json({ error: "rawGatewayPattern and displayLabel are required" }, { status: 400 });
  }

  const matchType = ["contains_match", "exact_match", "starts_with_match"].includes(String(body.matchType))
    ? body.matchType
    : "contains_match";
  const category = [
    "cash", "credit_card", "e_money", "qr", "transit_ic", "voucher", "paypal", "uncategorized",
  ].includes(String(body.category ?? ""))
    ? (body.category as string)
    : "uncategorized";

  const data = {
    shopId: shop.id,
    rawGatewayPattern,
    formattedGatewayPattern: body.formattedGatewayPattern ? String(body.formattedGatewayPattern).trim() : null,
    matchType,
    displayLabel,
    category,
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
    isVoucher: Boolean(body.isVoucher),
    voucherChangeSupported: Boolean(body.voucherChangeSupported),
    voucherNoChangeSupported: Boolean(body.voucherNoChangeSupported),
    selectableForSpecialRefund: body.selectableForSpecialRefund !== false,
    selectableForReceiptCashAdjustment: Boolean(body.selectableForReceiptCashAdjustment),
    selectableForPaymentOverride: Boolean(body.selectableForPaymentOverride),
    enabled: body.enabled !== false,
  };

  if (body.id) {
    const existing = await prisma.paymentMethodMaster.findFirst({
      where: { id: body.id, shopId: shop.id },
    });
    if (!existing) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const updated = await prisma.paymentMethodMaster.update({
      where: { id: body.id },
      data,
    });
    return Response.json({ item: updated });
  }

  const created = await prisma.paymentMethodMaster.create({ data });
  return Response.json({ item: created });
}
