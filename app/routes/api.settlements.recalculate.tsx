/**
 * POST /api/settlements/recalculate
 * 要件書 §21.3: 精算再集計
 *
 * Body: { settlementId } or { locationId, locationName, targetDate }
 *
 * 確定済みの日（点検以外の Settlement が completed / printed）は集計し直さず、DB の値を返す
 * （応答に confirmed: true）。Shopify の精算注文は書き換えない（T の決定「確定値を守る」）。
 * 確定前の日は従来どおり集計し直し、精算注文を更新する。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";
import { syncSettlementOrderLikeGas } from "../services/settlementOrderGas.server";
import { upsertDailySummaryCacheFromPreview } from "../services/salesSummaryEngine.server";
import { settlementApiErrorResponse } from "../utils/settlementApiError.server";
import { resolveSettlementOrderSyncOptions } from "../services/settlementSyncSettings.server";
import prisma from "../db.server";
import {
  CONFIRMED_SETTLEMENT_STATUSES,
  isConfirmedSettlementRow,
  locationIdVariants,
  settlementRowToPreview,
} from "../services/settlementConfirmedPure.server";

/**
 * その日・その店の確定済みの精算（点検は除く）を探す。settlementId が確定済みの行ならそれを使う。
 * 無ければ null（従来どおり集計し直す）。
 */
async function findConfirmedSettlementForDay(
  shopId: string,
  locationId: string,
  targetDate: string,
  settlementId: string | null,
) {
  if (settlementId) {
    const byId = await prisma.settlement.findFirst({ where: { id: settlementId, shopId } });
    if (byId && isConfirmedSettlementRow(byId)) return byId;
  }
  const rows = await prisma.settlement.findMany({
    where: {
      shopId,
      locationId: { in: locationIdVariants(locationId) },
      targetDate,
      status: { in: [...CONFIRMED_SETTLEMENT_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return rows.find((r: { periodLabel: string | null; status: string }) => isConfirmedSettlementRow(r)) ?? null;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return corsErrorJson(request, { error: "Method not allowed" }, 405);
  }
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const body = await request.json() as Record<string, unknown>;
    let { locationId, locationName, targetDate } = body;
    const { settlementId } = body;

    // settlementId が指定された場合は既存レコードから取得
    if (settlementId && !locationId) {
      const existing = await prisma.settlement.findFirst({
        where: { id: String(settlementId), shopId: shop.id },
      });
      if (!existing) {
        return corsJson({ ok: false, error: "Settlement not found" }, { status: 404 });
      }
      locationId = existing.locationId;
      targetDate = existing.targetDate;
      if (!locationName) {
        const locIdStr = String(locationId);
        const locIdGid = locIdStr.startsWith("gid://") ? locIdStr : `gid://shopify/Location/${locIdStr}`;
        const loc = await prisma.location.findFirst({
          where: { shopId: shop.id, shopifyLocationGid: locIdGid },
        });
        locationName = loc?.name ?? "";
      }
    }

    if (!locationId || !targetDate) {
      return corsJson(
        { ok: false, error: "locationId and targetDate are required" },
        { status: 400 }
      );
    }

    // T の決定（2026-11-22「確定値を守る」・Issue #20）: 確定済みの日は集計し直さず DB の値を返す。
    // Shopify の精算注文も、売上サマリーのキャッシュも書き換えない。
    const confirmed = await findConfirmedSettlementForDay(
      shop.id,
      String(locationId),
      String(targetDate),
      settlementId ? String(settlementId) : null,
    );
    if (confirmed) {
      return corsJson({
        ok: true,
        confirmed: true,
        settlementId: confirmed.id,
        preview: settlementRowToPreview(confirmed, String(locationName ?? "")),
        sourceOrderId: confirmed.sourceOrderId,
        sourceOrderName: confirmed.sourceOrderName,
      });
    }

    const preview = await buildSettlementPreview(
      admin,
      shop.id,
      String(locationId),
      String(locationName ?? ""),
      String(targetDate),
    );

    try {
      await upsertDailySummaryCacheFromPreview(
        shop.id,
        String(locationId),
        String(targetDate),
        preview,
      );
    } catch {
      // キャッシュ更新失敗は精算結果に影響させない
    }

    // GAS uiReupsertByOrder / upsertSettlement: 再集計後に Shopify 精算注文を更新
    let sourceOrderId: string | null = null;
    let sourceOrderName: string | null = null;
    const locIdStr = String(locationId);
    const locGid = locIdStr.startsWith("gid://") ? locIdStr : `gid://shopify/Location/${locIdStr}`;
    const dbLoc = await prisma.location.findFirst({
      where: { shopId: shop.id, shopifyLocationGid: locGid },
    });
    const printMode = dbLoc?.printMode ?? "order_based";
    const syncOpts = await resolveSettlementOrderSyncOptions(shop.id, printMode);
    if (syncOpts.createOrder) {
      const isInspection = Boolean(
        settlementId &&
          (await prisma.settlement.findFirst({
            where: { id: String(settlementId), shopId: shop.id },
            select: { periodLabel: true },
          }))?.periodLabel?.startsWith("点検_"),
      );
      if (!isInspection) {
        const sync = await syncSettlementOrderLikeGas(admin, shop.id, preview, {
          attachNote: syncOpts.attachNote,
          attachMetafields: syncOpts.attachMetafields,
        });
        sourceOrderId = sync.orderId;
        sourceOrderName = sync.orderName;
      }
    }

    return corsJson({ ok: true, preview, sourceOrderId, sourceOrderName });
  } catch (err) {
    return settlementApiErrorResponse(request, err);
  }
}
