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
import { encodeReceiptPrintSnapshot } from "../services/receiptPrintSnapshot.server";
import { renderPrintReceiptHtml } from "../services/printReceiptHtml";
import { receiptIssuerFromAttributedStaff } from "../utils/receiptIssuer";
import { getOrderAttributedStaff } from "../services/orderStaffAttribution.server";

const ORDER_QUERY = `#graphql
  query ReceiptIssueOrder($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      totalPriceSet { shopMoney { amount currencyCode } }
      retailLocation { id name }
    }
  }
`;

/**
 * 発行者＝注文の帰属スタッフ（販売の帰属スタッフ対応の記録から）。
 * 記録が無い・失敗のときは空にして、発行は止めない。
 */
async function readReceiptIssuer(
  shopId: string,
  orderId: string,
  opts: Parameters<typeof getOrderAttributedStaff>[2],
): Promise<{ createdBy: string | null; createdByStaffId: string | null }> {
  try {
    const res = await getOrderAttributedStaff(shopId, orderId, opts);
    return receiptIssuerFromAttributedStaff(res.recorded ? res.staffs : []);
  } catch {
    return { createdBy: null, createdByStaffId: null };
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, scope, corsJson } = authResult;

    const body = await request.json() as Record<string, unknown>;
    // 発行者は注文の帰属スタッフ（サーバーが注文の明細から引く）。POS から来る createdBy は使わない
    const { orderId, recipientName, proviso, isReissue, idempotencyKey } = body;

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
          retailLocation?: { id: string; name: string } | null;
        } | null;
      };
    };

    const order = orderJson.data?.order;
    if (!order) {
      return corsJson({ ok: false, error: "Order not found" }, { status: 404 });
    }

    const issuer = await readReceiptIssuer(shop.id, rawOrderId, { admin, scope });

    const tmpl = await prisma.receiptTemplate.findFirst({
      where: { shopId: shop.id, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    const templateData: ReceiptTemplateData = {
      ...DEFAULT_TEMPLATE,
      ...(tmpl ? (JSON.parse(tmpl.templateJson) as Partial<ReceiptTemplateData>) : {}),
    };

    const effectiveProviso = String(proviso || templateData.defaultProviso || "お買上品代として");
    const locationId = order.retailLocation?.id ?? "";
    const locationName = order.retailLocation?.name ?? "";
    const issued = await prisma.$transaction(async (tx) => {
      const created = await tx.receiptIssue.create({
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
          createdBy: issuer.createdBy,
          createdByStaffId: issuer.createdByStaffId,
          idempotencyKey: idempotencyKey && typeof idempotencyKey === "string"
            ? idempotencyKey
            : null,
        },
      });

      const model = {
        kind: "receipt" as const,
        title: "領　収　書",
        recipientName: created.recipientName ?? "",
        proviso: created.proviso ?? effectiveProviso,
        amount: Number(created.amount),
        currency: created.currency ?? "JPY",
        issueDate: created.createdAt.toISOString().slice(0, 10),
        orderName: created.orderName ?? undefined,
        locationName,
        companyName: templateData.companyName,
        address: templateData.address,
        phone: templateData.phone,
        showOrderNumber: Boolean(templateData.showOrderNumber ?? templateData.showOrderName),
        showDate: Boolean(templateData.showDate ?? templateData.showIssueDate),
      };
      const printSnapshotJson = encodeReceiptPrintSnapshot({
        locationName,
        templateData: templateData as unknown as Record<string, unknown>,
        renderedHtmlByPaperWidth: {
          58: renderPrintReceiptHtml({ ...model, paperWidthMm: 58 }),
          80: renderPrintReceiptHtml({ ...model, paperWidthMm: 80 }),
        },
      });

      return tx.receiptIssue.update({
        where: { id: created.id },
        data: { printSnapshotJson },
      });
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
      locationName,
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
