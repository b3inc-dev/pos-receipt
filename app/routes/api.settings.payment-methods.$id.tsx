/**
 * PATCH  /api/settings/payment-methods/:id — 更新
 * DELETE /api/settings/payment-methods/:id — 削除
 * 要件 §6
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const id = params.id;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const item = await prisma.paymentMethodMaster.findFirst({
    where: { id, shopId: shop.id },
  });
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const id = params.id;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const existing = await prisma.paymentMethodMaster.findFirst({
    where: { id, shopId: shop.id },
  });
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  if (request.method === "DELETE") {
    await prisma.paymentMethodMaster.delete({ where: { id } });
    return Response.json({ ok: true });
  }

  if (request.method === "PATCH") {
    const body = (await request.json()) as {
      rawGatewayPattern?: string;
      formattedGatewayPattern?: string | null;
      matchType?: string;
      displayLabel?: string;
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

    const data: Record<string, unknown> = {};
    if (body.rawGatewayPattern !== undefined) data.rawGatewayPattern = String(body.rawGatewayPattern).trim();
    if (body.formattedGatewayPattern !== undefined) data.formattedGatewayPattern = body.formattedGatewayPattern ? String(body.formattedGatewayPattern).trim() : null;
    if (body.matchType !== undefined && ["contains_match", "exact_match", "starts_with_match"].includes(body.matchType)) data.matchType = body.matchType;
    if (body.displayLabel !== undefined) data.displayLabel = String(body.displayLabel).trim();
    if (body.category !== undefined && ["cash", "credit_card", "e_money", "qr", "transit_ic", "voucher", "paypal", "uncategorized"].includes(body.category)) data.category = body.category;
    if (typeof body.sortOrder === "number") data.sortOrder = body.sortOrder;
    if (body.isVoucher !== undefined) data.isVoucher = Boolean(body.isVoucher);
    if (body.voucherChangeSupported !== undefined) data.voucherChangeSupported = Boolean(body.voucherChangeSupported);
    if (body.voucherNoChangeSupported !== undefined) data.voucherNoChangeSupported = Boolean(body.voucherNoChangeSupported);
    if (body.selectableForSpecialRefund !== undefined) data.selectableForSpecialRefund = Boolean(body.selectableForSpecialRefund);
    if (body.selectableForReceiptCashAdjustment !== undefined) data.selectableForReceiptCashAdjustment = Boolean(body.selectableForReceiptCashAdjustment);
    if (body.selectableForPaymentOverride !== undefined) data.selectableForPaymentOverride = Boolean(body.selectableForPaymentOverride);
    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);

    const updated = await prisma.paymentMethodMaster.update({
      where: { id },
      data: data as Parameters<typeof prisma.paymentMethodMaster.update>[0]["data"],
    });
    return Response.json({ item: updated });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
