/**
 * GET /api/admin/order-adjustments?orderId=… — 注文ページのブロック（extensions/order-adjustments-block）用。
 * その注文の特殊返金・商品券調整（アプリの記録から作った pos.adjustments の値）と、注文に書いてある値と同じかを返す。
 * 読むだけ。直すのはアプリの画面（/app/order-adjustments）で行う。
 * 形: docs/ORDER_ADJUSTMENTS_METAFIELD.md
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import prisma from "../db.server";
import {
  buildOrderAdjustmentsDocForOrder,
  fetchOrderAdjustmentDocs,
} from "../services/orderAdjustments.server";
import { orderMetafieldStateOf, toOrderGid } from "../services/orderAdjustmentsPure.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // 管理画面の拡張からの呼び出し（OPTIONS の事前確認も authenticate.admin が返す）
  const { admin, session, cors } = await authenticate.admin(request);
  const url = new URL(request.url);
  const orderIdRaw = (url.searchParams.get("orderId") ?? "").trim();
  if (!orderIdRaw) {
    return cors(Response.json({ ok: false, error: "orderId is required" }, { status: 400 }));
  }
  try {
    const shop = await resolveShop(session.shop, admin);
    const orderGid = toOrderGid(orderIdRaw);
    const digits = orderGid.replace(/\D/g, "");
    const [rowCount, built, current] = await Promise.all([
      prisma.specialRefundEvent.count({
        where: { shopId: shop.id, sourceOrderId: { in: [orderGid, digits, orderIdRaw] } },
      }),
      buildOrderAdjustmentsDocForOrder(admin, shop.id, orderGid),
      fetchOrderAdjustmentDocs(admin, [orderGid]),
    ]);
    const metafieldState = orderMetafieldStateOf({
      rowCount,
      fetched: current.fetched,
      currentValue: current.docs.get(orderGid) ?? null,
      built: built.doc,
    });
    return cors(
      Response.json({
        ok: true,
        orderGid,
        summary: built.summary,
        metafieldState,
        entries: built.doc.entries,
      }),
    );
  } catch (err) {
    console.error("[api.admin.order-adjustments]", err);
    return cors(Response.json({ ok: false, error: "読み込めませんでした。開き直してください。" }, { status: 500 }));
  }
}
