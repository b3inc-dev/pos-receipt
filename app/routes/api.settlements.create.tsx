/**
 * POST /api/settlements/create
 * 要件書 §21.3: 精算実行・保存
 *
 * - cloudprnt_direct: 集計してDB保存 → printable payload を返す
 * - order_based: 集計 → Shopify精算注文作成 → DB保存
 * - isInspection=true: 点検レシート（DB保存するが periodLabel に "点検_" プレフィックス）
 *
 * リトライ安全: locationId+targetDate+printMode のハッシュを idempotencyKey として使用。
 * 同一キーが既存の場合は重複精算を作成せず既存レコードを返す（点検レシートは除外）。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { buildSettlementPreview, buildSettlementReceiptText } from "../services/settlementEngine.server";
import { syncSettlementOrderLikeGas } from "../services/settlementOrderGas.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";

/** locationId + targetDate + printMode から冪等キーを生成 */
function buildIdempotencyKey(
  shopId: string,
  locationId: string,
  targetDate: string,
  printMode: string,
): string {
  return `${shopId}:${locationId}:${targetDate}:${printMode}`;
}

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
    const { locationId, locationName, targetDate, printMode, isInspection } = body;

    if (!locationId || !targetDate || !printMode) {
      return corsJson(
        { ok: false, error: "locationId, targetDate, printMode are required" },
        { status: 400 }
      );
    }

    // ── 冪等性チェック（点検レシートは対象外） ──────────────────────────────
    if (!isInspection) {
      const idemKey = buildIdempotencyKey(
        shop.id, String(locationId), String(targetDate), String(printMode)
      );
      const existingSettlement = await prisma.settlement.findUnique({
        where: { idempotencyKey: idemKey },
      });
      if (existingSettlement) {
        // GAS upsert は都度 Shopify 注文を更新する。order_based のときは再集計してメタ・ノートを同期する。
        if (String(printMode) === "order_based") {
          const preview = await buildSettlementPreview(
            admin,
            shop.id,
            String(locationId),
            String(locationName ?? ""),
            String(targetDate),
          );
          let sourceOrderId = existingSettlement.sourceOrderId;
          let sourceOrderName = existingSettlement.sourceOrderName;
          try {
            const sync = await syncSettlementOrderLikeGas(admin, shop.id, preview);
            sourceOrderId = sync.orderId;
            sourceOrderName = sync.orderName;
          } catch (syncErr) {
            const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
            return corsJson({ ok: false, error: msg }, { status: 500 });
          }
          try {
            await computeAndCacheDailySummary(
              admin,
              shop.id,
              String(locationId),
              String(locationName ?? ""),
              String(targetDate),
            );
          } catch {
            /* 同上 */
          }
          return corsJson(
            {
              ok: true,
              idempotent: true,
              settlementId: existingSettlement.id,
              preview,
              sourceOrderId,
              sourceOrderName,
              printMode: existingSettlement.printMode,
              isInspection: false,
            },
            { status: 200 }
          );
        }
        return corsJson(
          {
            ok: true,
            idempotent: true,
            settlementId: existingSettlement.id,
            preview: null,
            sourceOrderId: existingSettlement.sourceOrderId,
            sourceOrderName: existingSettlement.sourceOrderName,
            printMode: existingSettlement.printMode,
            isInspection: false,
          },
          { status: 200 }
        );
      }
    }

    const preview = await buildSettlementPreview(
      admin,
      shop.id,
      String(locationId),
      String(locationName ?? ""),
      String(targetDate),
    );

    // 精算と同様に、該当日の売上サマリーキャッシュを更新（期間表示と数値の一貫性を保つ）
    try {
      await computeAndCacheDailySummary(
        admin,
        shop.id,
        String(locationId),
        String(locationName ?? ""),
        String(targetDate),
      );
    } catch {
      // キャッシュ更新失敗は精算結果に影響させない
    }

    let sourceOrderId: string | null = null;
    let sourceOrderName: string | null = null;

    // ガイド 8.1: order_based のときのみ精算注文を生成。cloudprnt_direct のときは生成しない。点検レシートは作成しない。
    if (String(printMode) === "order_based" && !isInspection) {
      const result = await syncSettlementOrderLikeGas(admin, shop.id, preview);
      sourceOrderId = result.orderId;
      sourceOrderName = result.orderName;
    }

    const idemKey = !isInspection
      ? buildIdempotencyKey(shop.id, String(locationId), String(targetDate), String(printMode))
      : null;

    const settlement = await prisma.settlement.create({
      data: {
        shopId: shop.id,
        locationId: String(locationId),
        sourceOrderId,
        sourceOrderName,
        targetDate: String(targetDate),
        periodLabel: isInspection ? `点検_${String(targetDate)}` : String(targetDate),
        currency: preview.currency,
        total: preview.total,
        netSales: preview.netSales,
        tax: preview.tax,
        discounts: preview.discounts,
        vipPointsUsed: preview.vipPointsUsed,
        refundTotal: preview.refundTotal,
        orderCount: preview.orderCount,
        refundCount: preview.refundCount,
        itemCount: preview.itemCount,
        voucherChangeAmount: preview.voucherChangeAmount,
        paymentSectionsJson: JSON.stringify(preview.paymentSections),
        printMode: String(printMode),
        status: "completed",
        idempotencyKey: idemKey,
      },
    });

    // cloudprnt_direct 時は印字用 payload（テキスト）を返す。CloudPRNT 実機連携で利用。
    const printPayload =
      String(printMode) === "cloudprnt_direct" ? buildSettlementReceiptText(preview) : undefined;

    return corsJson(
      {
        ok: true,
        idempotent: false,
        settlementId: settlement.id,
        preview,
        sourceOrderId,
        sourceOrderName,
        printMode,
        isInspection: Boolean(isInspection),
        ...(printPayload !== undefined && { printPayload }),
      },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
