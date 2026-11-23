/**
 * orders/updated の知らせで動かす、注文の自動の調整（docs/VOUCHER_CART_ENTRY.md・docs/REFUND_RESERVATION.md）。
 *
 * - 売上サマリーのキュー（pg-boss）が動いている店は、キューの中で呼ぶ（知らせにはすぐ 200 を返す。見直し P2-6）
 * - キューが使えないときだけ、知らせの中で呼ぶ
 * - 失敗はログだけ（売上サマリーの処理は止めない）。会計後の画面・POS で開いたときにも同じ処理が動く
 */
import { applyRefundReservationsForOrder, hasPendingReservation } from "./refundReservation.server";
import { registerVoucherFromCartEntry, webhookPayloadHasVoucherCartFace } from "./voucherCartEntry.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

function orderIdOf(payload: unknown): string {
  const p = (payload ?? {}) as { admin_graphql_api_id?: string; id?: number | string };
  return String(p.admin_graphql_api_id ?? p.id ?? "");
}

export async function runOrderAutoAdjustmentsFromWebhook(
  admin: AdminClient,
  shopId: string,
  shopDomain: string,
  payload: unknown,
): Promise<void> {
  const orderId = orderIdOf(payload);
  if (!orderId) return;

  // 会計の前に入れた商品券の額面: 会計後の画面で登録できなかったときの拾い直し。知らせに項目がある注文だけ読む
  if (webhookPayloadHasVoucherCartFace(payload)) {
    try {
      const r = await registerVoucherFromCartEntry(admin, shopId, orderId);
      console.log(
        `[order-auto-adjust] voucher from cart entry order=${orderId.replace(/\D/g, "")} status=${r.status} shop=${shopDomain}`,
      );
    } catch (e) {
      console.warn(`[order-auto-adjust] voucher from cart entry failed shop=${shopDomain}`, e);
    }
  }

  // 返金の予約: その注文に使う前の予約があるときだけ、Shopify の返金を読んで付け替えを作る
  try {
    if (await hasPendingReservation(shopId, orderId)) {
      const r = await applyRefundReservationsForOrder(admin, shopId, orderId);
      if (r.applied || r.review) {
        console.log(`[order-auto-adjust] refund reservation applied=${r.applied} review=${r.review} shop=${shopDomain}`);
      }
    }
  } catch (e) {
    console.warn(`[order-auto-adjust] refund reservation failed shop=${shopDomain}`, e);
  }
}
