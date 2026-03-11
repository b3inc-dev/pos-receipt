/**
 * POST /api/receipts/preview
 * 要件書 §21.5: 領収書プレビュー（DB保存なし）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { DEFAULT_TEMPLATE, type ReceiptTemplateData } from "./api.settings.receipt-template";

const ORDER_QUERY = `#graphql
  query ReceiptOrder($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      totalPriceSet { shopMoney { amount currencyCode } }
      location { id name }
    }
  }
`;

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

    const body = await request.json() as Record<string, unknown>;
    const { orderId, recipientName, proviso } = body;

    if (!orderId) {
      return Response.json({ ok: false, error: "orderId is required" }, { status: 400 });
    }

    const gid = String(orderId).startsWith("gid://")
      ? String(orderId)
      : `gid://shopify/Order/${orderId}`;

    const orderRes = await admin.graphql(ORDER_QUERY, { variables: { id: gid } });
    const orderJson = await orderRes.json() as {
      data?: {
        order?: {
          id: string;
          name: string;
          createdAt: string;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          location?: { id: string; name: string } | null;
        } | null;
      };
    };

    const order = orderJson.data?.order;
    if (!order) {
      return Response.json({ ok: false, error: "Order not found" }, { status: 404 });
    }

    // アクティブテンプレート取得
    const tmpl = await prisma.receiptTemplate.findFirst({
      where: { shopId: shop.id, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    const templateData: ReceiptTemplateData = {
      ...DEFAULT_TEMPLATE,
      ...(tmpl ? (JSON.parse(tmpl.templateJson) as Partial<ReceiptTemplateData>) : {}),
    };

    const issueDate = new Date().toISOString().slice(0, 10);
    const effectiveProviso = String(proviso || templateData.defaultProviso || "お買上品代として");

    const preview = {
      orderId: order.id.replace("gid://shopify/Order/", ""),
      orderName: order.name,
      recipientName: String(recipientName || ""),
      proviso: effectiveProviso,
      amount: Number(order.totalPriceSet.shopMoney.amount),
      currency: order.totalPriceSet.shopMoney.currencyCode,
      issueDate,
      locationName: order.location?.name ?? "",
      companyName: templateData.companyName,
      address: templateData.address,
      phone: templateData.phone,
      showOrderNumber: templateData.showOrderNumber,
      showDate: templateData.showDate,
      templateVersion: tmpl?.version ?? 1,
    };

    return Response.json({ ok: true, preview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
