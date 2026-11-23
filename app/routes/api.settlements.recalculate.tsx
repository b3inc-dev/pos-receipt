/**
 * POST /api/settlements/recalculate
 * 要件書 §21.3: 精算再集計
 *
 * Body: { settlementId } or { locationId, locationName, targetDate }
 *
 * 確定済みの日（点検以外の Settlement が completed / printed）は DB の確定値を preview で返す
 * （応答に confirmed: true）。Shopify の精算注文は書き換えない（T の決定「確定値を守る」）。
 * 比べるために今の集計を 1 回行い、違えば changedSinceConfirm: true・livePreview を返す
 * （再確定は api.settlements.create の reconfirm: true）。
 * 確定前の日は集計し直すだけ（#22: Shopify の精算注文は作らない・更新しない）。
 * ライブ再集計はプレビュー／日次キャッシュのみ。Shopify 精算注文は更新しない。
 * 再印刷は保存済み Settlement を使う（本 API は帳票スナップショットを書き換えない）。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";
import { upsertDailySummaryCacheFromPreview } from "../services/salesSummaryEngine.server";
import { settlementApiErrorResponse } from "../utils/settlementApiError.server";
import prisma from "../db.server";
import {
  CONFIRMED_SETTLEMENT_STATUSES,
  diffConfirmedVsLive,
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

    // T の決定（2026-11-22「確定値を守る」・Issue #20）: 確定済みの日は DB の確定値を返す。
    // Shopify の精算注文は書き換えない。今の集計は比べるためだけに 1 回行い、数が変わっていれば
    // changedSinceConfirm: true と今の値（livePreview）を返す。POS はこれを見て再確定を出す
    // （T の決定 2026-11-23 4:20。再確定は api.settlements.create の reconfirm: true）。
    const confirmed = await findConfirmedSettlementForDay(
      shop.id,
      String(locationId),
      String(targetDate),
      settlementId ? String(settlementId) : null,
    );
    if (confirmed) {
      const confirmedPreview = settlementRowToPreview(confirmed, String(locationName ?? ""));
      const livePreview = await buildSettlementPreview(
        admin,
        shop.id,
        String(locationId),
        String(locationName ?? ""),
        String(targetDate),
      );
      try {
        // 売上サマリーは今の数（従来どおり）。確定値とずれたら POS が再確定を出す
        await upsertDailySummaryCacheFromPreview(
          shop.id,
          String(locationId),
          String(targetDate),
          livePreview,
        );
      } catch {
        // キャッシュ更新失敗は精算結果に影響させない
      }
      const diff = diffConfirmedVsLive(confirmedPreview, livePreview);
      return corsJson({
        ok: true,
        confirmed: true,
        settlementId: confirmed.id,
        preview: confirmedPreview,
        changedSinceConfirm: diff.changedFields.length > 0,
        changedFields: diff.changedFields,
        livePreview,
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

    return corsJson({
      ok: true,
      preview,
      sourceOrderId: null,
      sourceOrderName: null,
    });
  } catch (err) {
    return settlementApiErrorResponse(request, err);
  }
}
