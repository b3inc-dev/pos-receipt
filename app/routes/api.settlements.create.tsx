/**
 * POST /api/settlements/create
 * 要件書 §21.3: 精算実行・保存
 *
 * - cloudprnt_direct: 集計してDB保存 → printable payload を返す
 * - order_based: 集計 → Shopify精算注文作成 → DB保存
 * - isInspection=true: 点検レシート（DB保存するが periodLabel に "点検_" プレフィックス）
 *
 * 印字方式 printMode はリクエスト body ではなく DB（Location.printMode）で決定（未登録は order_based）。
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

/** Prisma / Shopify の GID を api.locations と同じ形に揃える */
function normalizeLocationGid(locationId: string): string {
  const s = String(locationId).trim();
  if (s.startsWith("gid://shopify/Location/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
  return s;
}

/**
 * 印字方式は POS からの body ではなく DB（Location）を正とする。
 * api.locations と同じく「未登録ロケーションは order_based」。
 * これにより、拡張側のマージ遅延や古いキャッシュで body と DB が食い違っても、
 * 注文が作られない／完了画面だけ注文経由に見える不整合を防ぐ。
 */
async function resolveEffectivePrintMode(shopId: string, locationId: string): Promise<string> {
  const gid = normalizeLocationGid(locationId);
  const dbLoc = await prisma.location.findFirst({
    where: { shopId, shopifyLocationGid: gid },
  });
  return dbLoc?.printMode ?? "order_based";
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
    const { locationId, locationName, targetDate, isInspection } = body;

    if (!locationId || !targetDate) {
      return corsJson(
        { ok: false, error: "locationId and targetDate are required" },
        { status: 400 }
      );
    }

    const effectivePrintMode = await resolveEffectivePrintMode(shop.id, String(locationId));

    // ── 冪等性チェック（点検レシートは対象外） ──────────────────────────────
    if (!isInspection) {
      const idemKey = buildIdempotencyKey(
        shop.id, String(locationId), String(targetDate), effectivePrintMode
      );
      const existingSettlement = await prisma.settlement.findUnique({
        where: { idempotencyKey: idemKey },
      });
      if (existingSettlement) {
        // GAS upsert は都度 Shopify 注文を更新する。order_based のときは再集計してメタ・ノートを同期する。
        if (effectivePrintMode === "order_based") {
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
              printMode: effectivePrintMode,
              targetDate: existingSettlement.targetDate,
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
            printMode: effectivePrintMode,
            targetDate: existingSettlement.targetDate,
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
    if (effectivePrintMode === "order_based" && !isInspection) {
      const result = await syncSettlementOrderLikeGas(admin, shop.id, preview);
      sourceOrderId = result.orderId;
      sourceOrderName = result.orderName;
    }

    const idemKey = !isInspection
      ? buildIdempotencyKey(shop.id, String(locationId), String(targetDate), effectivePrintMode)
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
        printMode: effectivePrintMode,
        status: "completed",
        idempotencyKey: idemKey,
      },
    });

    // cloudprnt_direct 時は印字用 payload（テキスト）を返す。CloudPRNT 実機連携で利用。
    const printPayload =
      effectivePrintMode === "cloudprnt_direct" ? buildSettlementReceiptText(preview) : undefined;

    return corsJson(
      {
        ok: true,
        idempotent: false,
        settlementId: settlement.id,
        preview,
        sourceOrderId,
        sourceOrderName,
        printMode: effectivePrintMode,
        targetDate: String(targetDate),
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
