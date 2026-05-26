/**
 * GET /api/debug/settlement-compare?locationId=gid://shopify/Location/xxx&locationName=店名&targetDate=YYYY-MM-DD
 *
 * GAS・ciara-system との集計差分を確認するためのデバッグエンドポイント。
 * インハウスモード（APP_DISTRIBUTION=inhouse）のみ有効。
 *
 * レスポンスは人間が読みやすいよう、GAS の列名に対応する形で整理して返す。
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { isInhouseMode } from "../utils/planFeatures.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isInhouseMode()) {
    return Response.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
  }

  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  const locationName = url.searchParams.get("locationName") ?? "";
  const targetDate = url.searchParams.get("targetDate");

  if (!locationId || !targetDate) {
    return Response.json(
      {
        ok: false,
        error: "locationId and targetDate are required",
        example: "/api/debug/settlement-compare?locationId=gid://shopify/Location/12345&locationName=店名&targetDate=2025-05-26",
      },
      { status: 400 },
    );
  }

  const preview = await buildSettlementPreview(
    admin,
    shop.id,
    locationId,
    locationName,
    targetDate,
    { debug: true },
  );

  // GAS / ciara-system との比較用に整理
  const paymentMap: Record<string, { sale: number; refund: number; txCount: number; refundCount: number }> = {};
  for (const s of preview.paymentSections) {
    paymentMap[s.label] = {
      sale: s.net,
      refund: s.refund,
      txCount: s.txCount,
      refundCount: s.refundCount,
    };
  }

  return Response.json({
    ok: true,
    meta: {
      shop: session.shop,
      locationId: preview.locationId,
      locationName: preview.locationName,
      targetDate: preview.targetDate,
      currency: preview.currency,
    },

    // ── GAS / aggregate() と直接対応するフィールド ──────────────────
    summary: {
      netSales: preview.netSales,          // GAS: _actual
      total: preview.total,                // GAS: _total（税込売上合計）
      tax: preview.tax,                    // GAS: _tax
      taxShopify: preview.taxShopify,      // GAS: _tax_shopify
      discounts: preview.discounts,        // GAS: _discount
      vipPointsUsed: preview.vipPointsUsed, // GAS: _vip
      loyaltyUsageDisplay: preview.loyaltyUsageDisplayLabel,
      refundTotal: preview.refundTotal,    // GAS: returns
      orderCount: preview.orderCount,      // GAS: _order_count
      refundCount: preview.refundCount,    // GAS: refund_order_count
      itemCount: preview.itemCount,        // GAS: item_count
      voucherChangeAmount: preview.voucherChangeAmount, // GAS: voucher_change_total
    },

    // ── 支払セクション（GAS の paymentData 相当） ──────────────────
    paymentSections: paymentMap,

    // ── 特殊返金・商品券調整（pos-receipt 独自） ───────────────────
    appliedSpecialRefundEvents: preview.appliedSpecialRefundEvents,
    appliedVoucherAdjustments: preview.appliedVoucherAdjustments,

    // ── legacy ギフトカード ─────────────────────────────────────────
    ...(preview.legacyGiftCardsAddedAmount !== undefined && {
      legacyGiftCards: {
        addedAmount: preview.legacyGiftCardsAddedAmount,
        addedCount: preview.legacyGiftCardsAddedCount,
      },
    }),

    // ── デバッグ（注文件数の内訳） ──────────────────────────────────
    debug: {
      ...preview.debug,
      settlementTxRange: preview.settlementTxFirstHm && preview.settlementTxLastHm
        ? `${preview.settlementTxFirstHm}–${preview.settlementTxLastHm}`
        : null,
    },
  });
}
