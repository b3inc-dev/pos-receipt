/**
 * POST /api/settlements/create
 * 要件書 §21.3: 精算実行・保存
 *
 * 印字は shopify.printing に統一。SETTLEMENT / INSPECTION 注文は作らない。
 * 保存済み Location.printMode が order_based / cloudprnt_direct でも旧経路は復活しない。
 * 冪等キーは shopId:locationId:targetDate（旧 printMode 付きキーも検索し、精算行を増やさない）。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import {
  buildSettlementLockKey,
  withSettlementOperationLock,
} from "../services/settlementLock.server";
import {
  UNIFIED_PRINT_MODE,
  allSettlementIdempotencyKeys,
  buildSettlementIdempotencyKey,
  settlementRowToPreviewDTO,
} from "../services/printUnification.server";

function normalizeLocationGid(locationId: string): string {
  const s = String(locationId).trim();
  if (s.startsWith("gid://shopify/Location/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
  return s;
}

async function findExistingDailySettlement(
  shopId: string,
  locationId: string,
  targetDate: string,
) {
  const keys = allSettlementIdempotencyKeys(shopId, String(locationId), String(targetDate));
  const byKey = await prisma.settlement.findFirst({
    where: { shopId, idempotencyKey: { in: keys } },
    orderBy: { createdAt: "desc" },
  });
  if (byKey) return byKey;

  return prisma.settlement.findFirst({
    where: {
      shopId,
      locationId: String(locationId),
      targetDate: String(targetDate),
      NOT: { periodLabel: { startsWith: "点検_" } },
    },
    orderBy: { createdAt: "desc" },
  });
}

async function locationNameFor(shopId: string, locationId: string, fallback: string) {
  const gid = normalizeLocationGid(locationId);
  const loc = await prisma.location.findFirst({
    where: { shopId, shopifyLocationGid: gid },
  });
  return loc?.displayName ?? loc?.name ?? fallback;
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

    const inspection = Boolean(isInspection);
    const lockKey = buildSettlementLockKey(
      shop.id,
      String(locationId),
      String(targetDate),
      inspection ? "inspection" : "settlement",
    );

    const respondExisting = async (existing: NonNullable<Awaited<ReturnType<typeof findExistingDailySettlement>>>) => {
      const locName = await locationNameFor(shop.id, String(locationId), String(locationName ?? ""));
      const preview = settlementRowToPreviewDTO(existing, locName);
      return corsJson(
        {
          ok: true,
          idempotent: true,
          settlementId: existing.id,
          preview,
          sourceOrderId: existing.sourceOrderId,
          sourceOrderName: existing.sourceOrderName,
          printMode: UNIFIED_PRINT_MODE,
          targetDate: existing.targetDate,
          isInspection: false,
        },
        { status: 200 },
      );
    };

    if (!inspection) {
      const existingSettlement = await findExistingDailySettlement(
        shop.id,
        String(locationId),
        String(targetDate),
      );
      if (existingSettlement) {
        return await withSettlementOperationLock(lockKey, async () => respondExisting(existingSettlement));
      }
    }

    return await withSettlementOperationLock(lockKey, async () => {
      if (!inspection) {
        const raced = await findExistingDailySettlement(
          shop.id,
          String(locationId),
          String(targetDate),
        );
        if (raced) return respondExisting(raced);
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

      const idemKey = !inspection
        ? buildSettlementIdempotencyKey(shop.id, String(locationId), String(targetDate))
        : null;

      const settlement = await prisma.settlement.create({
        data: {
          shopId: shop.id,
          locationId: String(locationId),
          sourceOrderId: null,
          sourceOrderName: null,
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
          printMode: UNIFIED_PRINT_MODE,
          status: "completed",
          idempotencyKey: idemKey,
        },
      });

      return corsJson(
        {
          ok: true,
          idempotent: false,
          settlementId: settlement.id,
          preview,
          sourceOrderId: null,
          sourceOrderName: null,
          printMode: UNIFIED_PRINT_MODE,
          targetDate: String(targetDate),
          isInspection: inspection,
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
