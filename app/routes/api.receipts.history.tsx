/**
 * GET /api/receipts/history
 * 要件書 §21.5: 領収書発行履歴
 * Query: orderId?, dateFrom?, dateTo?, limit?
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticatePosRequest } from "../utils/posAuth.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, shop, corsJson } = await authenticatePosRequest(request);

    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20);

    const where: Parameters<typeof prisma.receiptIssue.findMany>[0]["where"] = {
      shopId: shop.id,
    };
    if (orderId) (where as Record<string, unknown>).orderId = orderId;
    if (dateFrom || dateTo) {
      const createdAt: Record<string, Date> = {};
      if (dateFrom) createdAt.gte = new Date(`${dateFrom}T00:00:00.000Z`);
      if (dateTo) createdAt.lte = new Date(`${dateTo}T23:59:59.999Z`);
      (where as Record<string, unknown>).createdAt = createdAt;
    }

    const items = await prisma.receiptIssue.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return corsJson({
      items: items.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderName: r.orderName,
        locationId: r.locationId,
        recipientName: r.recipientName,
        proviso: r.proviso,
        amount: r.amount.toString(),
        currency: r.currency,
        isReissue: r.isReissue,
        templateVersion: r.templateVersion,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsJson({ ok: false, error: message }, { status: 500 });
  }
}
