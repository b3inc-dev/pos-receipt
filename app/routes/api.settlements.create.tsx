/**
 * POST /api/settlements/create
 * 要件書 §21.3: 精算実行・保存
 *
 * - cloudprnt_direct: 集計してDB保存 → printable payload を返す
 * - order_based: 集計 → Shopify精算注文作成（GAS newSettlementFresh 相当）→ DB保存
 * - isInspection=true: 点検レシート（GAS uiCreateZeroInspection 相当）
 *
 * 印字方式 printMode はリクエスト body ではなく DB（Location.printMode）で決定（未登録は order_based）。
 * リトライ安全: locationId+targetDate+printMode のハッシュを idempotencyKey として使用。
 * 同一キーが既存の場合は重複精算を作成せず既存レコードを返す（点検レシートは除外）。
 * Shopify 同期は GAS Script Lock 相当の DB ロックで直列化。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { buildSettlementPreview, buildSettlementReceiptText } from "../services/settlementEngine.server";
import {
  syncSettlementOrderLikeGas,
  syncInspectionOrderLikeGas,
} from "../services/settlementOrderGas.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import {
  buildSettlementLockKey,
  withSettlementOperationLock,
} from "../services/settlementLock.server";
import { resolveSettlementOrderSyncOptions } from "../services/settlementSyncSettings.server";

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

async function resolveEffectivePrintMode(shopId: string, locationId: string): Promise<string> {
  const gid = normalizeLocationGid(locationId);
  const dbLoc = await prisma.location.findFirst({
    where: { shopId, shopifyLocationGid: gid },
  });
  return dbLoc?.printMode ?? "order_based";
}

async function syncShopifySettlementOrder(
  admin: Parameters<typeof syncSettlementOrderLikeGas>[0],
  shopId: string,
  preview: Awaited<ReturnType<typeof buildSettlementPreview>>,
  printMode: string,
  isInspection: boolean,
  locationName: string,
): Promise<{ sourceOrderId: string | null; sourceOrderName: string | null }> {
  const syncOpts = await resolveSettlementOrderSyncOptions(shopId, printMode);
  if (!syncOpts.createOrder) {
    return { sourceOrderId: null, sourceOrderName: null };
  }

  if (isInspection) {
    const result = await syncInspectionOrderLikeGas(admin, shopId, locationName, {
      attachNote: syncOpts.attachNote,
      attachMetafields: syncOpts.attachMetafields,
      fulfillOnCreate: true,
    });
    return { sourceOrderId: result.orderId, sourceOrderName: result.orderName };
  }

  const result = await syncSettlementOrderLikeGas(admin, shopId, preview, {
    attachNote: syncOpts.attachNote,
    attachMetafields: syncOpts.attachMetafields,
  });
  return { sourceOrderId: result.orderId, sourceOrderName: result.orderName };
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
        { status: 400 },
      );
    }

    const effectivePrintMode = await resolveEffectivePrintMode(shop.id, String(locationId));
    const inspection = Boolean(isInspection);
    const lockKey = buildSettlementLockKey(
      shop.id,
      String(locationId),
      String(targetDate),
      inspection ? "inspection" : "settlement",
    );

    // ── 冪等性チェック（点検レシートは対象外） ──────────────────────────────
    if (!inspection) {
      const idemKey = buildIdempotencyKey(
        shop.id, String(locationId), String(targetDate), effectivePrintMode,
      );
      const existingSettlement = await prisma.settlement.findUnique({
        where: { idempotencyKey: idemKey },
      });
      if (existingSettlement) {
        return await withSettlementOperationLock(lockKey, async () => {
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
              const sync = await syncShopifySettlementOrder(
                admin,
                shop.id,
                preview,
                effectivePrintMode,
                false,
                String(locationName ?? ""),
              );
              sourceOrderId = sync.sourceOrderId;
              sourceOrderName = sync.sourceOrderName;
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
              /* キャッシュ失敗は精算結果に影響させない */
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
              { status: 200 },
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
            { status: 200 },
          );
        });
      }
    }

    return await withSettlementOperationLock(lockKey, async () => {
      // ロック内で再チェック（レース対策）
      if (!inspection) {
        const idemKey = buildIdempotencyKey(
          shop.id, String(locationId), String(targetDate), effectivePrintMode,
        );
        const raced = await prisma.settlement.findUnique({ where: { idempotencyKey: idemKey } });
        if (raced) {
          const preview = await buildSettlementPreview(
            admin,
            shop.id,
            String(locationId),
            String(locationName ?? ""),
            String(targetDate),
          );
          let sourceOrderId = raced.sourceOrderId;
          let sourceOrderName = raced.sourceOrderName;
          if (effectivePrintMode === "order_based") {
            const sync = await syncShopifySettlementOrder(
              admin,
              shop.id,
              preview,
              effectivePrintMode,
              false,
              String(locationName ?? ""),
            );
            sourceOrderId = sync.sourceOrderId;
            sourceOrderName = sync.sourceOrderName;
          }
          return corsJson(
            {
              ok: true,
              idempotent: true,
              settlementId: raced.id,
              preview,
              sourceOrderId,
              sourceOrderName,
              printMode: effectivePrintMode,
              targetDate: raced.targetDate,
              isInspection: false,
            },
            { status: 200 },
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

      try {
        await computeAndCacheDailySummary(
          admin,
          shop.id,
          String(locationId),
          String(locationName ?? ""),
          String(targetDate),
        );
      } catch {
        /* キャッシュ更新失敗は精算結果に影響させない */
      }

      let sourceOrderId: string | null = null;
      let sourceOrderName: string | null = null;

      if (effectivePrintMode === "order_based") {
        const sync = await syncShopifySettlementOrder(
          admin,
          shop.id,
          preview,
          effectivePrintMode,
          inspection,
          String(locationName ?? ""),
        );
        sourceOrderId = sync.sourceOrderId;
        sourceOrderName = sync.sourceOrderName;
      }

      const idemKey = !inspection
        ? buildIdempotencyKey(shop.id, String(locationId), String(targetDate), effectivePrintMode)
        : null;

      const settlement = await prisma.settlement.create({
        data: {
          shopId: shop.id,
          locationId: String(locationId),
          sourceOrderId,
          sourceOrderName,
          targetDate: String(targetDate),
          periodLabel: inspection ? `点検_${String(targetDate)}` : String(targetDate),
          currency: preview.currency,
          total: inspection ? 0 : preview.total,
          netSales: inspection ? 0 : preview.netSales,
          tax: inspection ? 0 : preview.tax,
          discounts: inspection ? 0 : preview.discounts,
          vipPointsUsed: inspection ? 0 : preview.vipPointsUsed,
          refundTotal: inspection ? 0 : preview.refundTotal,
          orderCount: inspection ? 0 : preview.orderCount,
          refundCount: inspection ? 0 : preview.refundCount,
          itemCount: inspection ? 0 : preview.itemCount,
          voucherChangeAmount: inspection ? 0 : preview.voucherChangeAmount,
          paymentSectionsJson: JSON.stringify(inspection ? [] : preview.paymentSections),
          printMode: effectivePrintMode,
          status: "completed",
          idempotencyKey: idemKey,
        },
      });

      const printPayload =
        effectivePrintMode === "cloudprnt_direct" && !inspection
          ? buildSettlementReceiptText(preview)
          : undefined;

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
          isInspection: inspection,
          ...(printPayload !== undefined && { printPayload }),
        },
        { status: 201 },
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("混み合っています") ? 429 : 500;
    return corsErrorJson(request, { ok: false, error: message }, status);
  }
}
