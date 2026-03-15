/**
 * POST /api/receipts/issue
 * 要件書 §21.5: 領収書発行・再発行 + DB保存
 *
 * リトライ安全: クライアントが idempotencyKey（UUID）を送信することで、
 * ネットワーク再試行時に重複発行を防ぐ。同一キーが既存の場合は既存レコードを返す。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { DEFAULT_TEMPLATE, type ReceiptTemplateData } from "./api.settings.receipt-template";

const ORDER_QUERY = `#graphql
  query ReceiptIssueOrder($id: ID!) {
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
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const body = await request.json() as Record<string, unknown>;
    const { orderId, recipientName, proviso, isReissue, createdBy, idempotencyKey } = body;

    if (!orderId) {
      return corsJson({ ok: false, error: "orderId is required" }, { status: 400 });
    }

    // ── 冪等性チェック ──────────────────────────────────────────────────────
    // 同一 idempotencyKey が既に存在する場合は重複発行せず既存レコードを返す
    if (idempotencyKey && typeof idempotencyKey === "string") {
      const existing = await prisma.receiptIssue.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return corsJson(
          {
            ok: true,
            idempotent: true,
            receipt: {
              receiptIssueId: existing.id,
              orderId: existing.orderId,
              orderName: existing.orderName,
              recipientName: existing.recipientName,
              proviso: existing.proviso,
              amount: Number(existing.amount),
              currency: existing.currency,
              issueDate: existing.createdAt.toISOString().slice(0, 10),
              isReissue: existing.isReissue,
              templateVersion: existing.templateVersion,
            },
          },
          { status: 200 }
        );
      }
    }

    const gid = String(orderId).startsWith("gid://")
      ? String(orderId)
      : `gid://shopify/Order/${orderId}`;
    const rawOrderId = gid.replace("gid://shopify/Order/", "");

    const orderRes = await admin.graphql(ORDER_QUERY, { variables: { id: gid } });
    const orderJson = await orderRes.json() as {
      data?: {
        order?: {
          id: string;
          name: string;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          location?: { id: string; name: string } | null;
        } | null;
      };
    };

    const order = orderJson.data?.order;
    if (!order) {
      return corsJson({ ok: false, error: "Order not found" }, { status: 404 });
    }

    const tmpl = await prisma.receiptTemplate.findFirst({
      where: { shopId: shop.id, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    const templateData: ReceiptTemplateData = {
      ...DEFAULT_TEMPLATE,
      ...(tmpl ? (JSON.parse(tmpl.templateJson) as Partial<ReceiptTemplateData>) : {}),
    };

    const effectiveProviso = String(proviso || templateData.defaultProviso || "お買上品代として");
    const locationId = order.location?.id ?? "";

    const issued = await prisma.receiptIssue.create({
      data: {
        shopId: shop.id,
        orderId: rawOrderId,
        orderName: order.name,
        locationId,
        recipientName: String(recipientName || ""),
        proviso: effectiveProviso,
        amount: Number(order.totalPriceSet.shopMoney.amount),
        currency: order.totalPriceSet.shopMoney.currencyCode,
        templateId: tmpl?.id ?? null,
        templateVersion: tmpl?.version ?? 1,
        isReissue: Boolean(isReissue),
        createdBy: createdBy ? String(createdBy) : null,
        idempotencyKey: idempotencyKey && typeof idempotencyKey === "string"
          ? idempotencyKey
          : null,
      },
    });

    const issueDate = issued.createdAt.toISOString().slice(0, 10);

    const receiptData = {
      receiptIssueId: issued.id,
      orderId: rawOrderId,
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
      isReissue: Boolean(isReissue),
      templateVersion: tmpl?.version ?? 1,
    };

    return corsJson({ ok: true, idempotent: false, receipt: receiptData }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
