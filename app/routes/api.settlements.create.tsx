/**
 * POST /api/settlements/create
 * 要件書 §21.3: 精算実行・保存
 *
 * - cloudprnt_direct: 集計してDB保存 → printable payload を返す
 * - order_based: 集計 → Shopify精算注文作成（GAS newSettlementFresh 相当）→ DB保存
 * - isInspection=true: 点検レシート（GAS uiCreateZeroInspection 相当）。0 円で保存するので集計しない
 *
 * 印字方式 printMode はリクエスト body ではなく DB（Location.printMode）で決定（未登録は order_based）。
 * リトライ安全: locationId+targetDate+printMode のハッシュを idempotencyKey として使用。
 * 同一キーが既存の場合は重複精算を作成せず既存レコードを返す（点検レシートは除外）。
 * このとき集計し直さず、Shopify の精算注文も書き換えず、DB の確定値を preview として返す
 * （T の決定「確定値を守る」2026-11-22・Issue #20）。
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
import { upsertDailySummaryCacheFromPreview } from "../services/salesSummaryEngine.server";
import { settlementRowToPreview } from "../services/settlementConfirmedPure.server";
import {
  buildSettlementLockKey,
  withSettlementOperationLock,
} from "../services/settlementLock.server";
import { resolveSettlementOrderSyncOptions } from "../services/settlementSyncSettings.server";
import { UpstreamAggregationError } from "../services/settlementUpstreamPage.server";
import { SpecialRefundPendingError } from "../services/specialRefundOverlayPure.server";

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
  /** 点検レシートのときは集計しないので null */
  preview: Awaited<ReturnType<typeof buildSettlementPreview>> | null,
  printMode: string,
  isInspection: boolean,
  locationName: string,
): Promise<{
  sourceOrderId: string | null;
  sourceOrderName: string | null;
  /** 設定で精算注文を作らない（失敗ではない）。POS はこのとき「再インストール」の案内を出さない */
  settlementOrderSkipped: boolean;
}> {
  const syncOpts = await resolveSettlementOrderSyncOptions(shopId, printMode);
  if (!syncOpts.createOrder) {
    return { sourceOrderId: null, sourceOrderName: null, settlementOrderSkipped: true };
  }

  if (isInspection) {
    const result = await syncInspectionOrderLikeGas(admin, shopId, locationName, {
      attachNote: syncOpts.attachNote,
      attachMetafields: syncOpts.attachMetafields,
      fulfillOnCreate: true,
    });
    return {
      sourceOrderId: result.orderId,
      sourceOrderName: result.orderName,
      settlementOrderSkipped: false,
    };
  }

  if (!preview) {
    throw new Error("精算の集計結果がありません");
  }
  const result = await syncSettlementOrderLikeGas(admin, shopId, preview, {
    attachNote: syncOpts.attachNote,
    attachMetafields: syncOpts.attachMetafields,
  });
  return {
    sourceOrderId: result.orderId,
    sourceOrderName: result.orderName,
    settlementOrderSkipped: false,
  };
}

type SettlementRow = NonNullable<Awaited<ReturnType<typeof prisma.settlement.findUnique>>>;

/**
 * 確定済みの精算をもう一度押されたときの応答（T の決定「確定値を守る」）。
 * 集計し直さず、Shopify の精算注文も書き換えず、DB に保存した値をそのまま返す。
 */
function confirmedSettlementResponse(
  row: SettlementRow,
  printMode: string,
  locationName: string,
) {
  return {
    ok: true,
    idempotent: true,
    /** 確定済みの値（DB）を返したことを示す。集計し直した値ではない */
    confirmed: true,
    settlementId: row.id,
    preview: settlementRowToPreview(row, locationName),
    sourceOrderId: row.sourceOrderId,
    sourceOrderName: row.sourceOrderName,
    // order_based で精算注文が無い行は、設定で作らなかった行（作成に失敗したときは行を保存しない）
    settlementOrderSkipped: printMode === "order_based" && !row.sourceOrderName,
    printMode,
    targetDate: row.targetDate,
    isInspection: false,
  };
}

/**
 * 点検レシートは集計しないので、通貨は同じ店の直近の精算から取る。無ければ null
 * （印字は null を JPY として扱う。0 件の日の集計と同じ既定値）。
 */
async function resolveInspectionCurrency(shopId: string): Promise<string | null> {
  const last = await prisma.settlement.findFirst({
    where: { shopId, currency: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { currency: true },
  });
  return last?.currency ?? null;
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
    // T の決定（2026-11-22「確定値を守る」・Issue #20）: 確定済みの日は集計し直さず、
    // DB の値を返す。Shopify の精算注文も書き換えない。売上サマリーのキャッシュも触らない。
    const idemKey = !inspection
      ? buildIdempotencyKey(shop.id, String(locationId), String(targetDate), effectivePrintMode)
      : null;
    if (idemKey) {
      const existingSettlement = await prisma.settlement.findUnique({
        where: { idempotencyKey: idemKey },
      });
      if (existingSettlement) {
        return corsJson(
          confirmedSettlementResponse(existingSettlement, effectivePrintMode, String(locationName ?? "")),
          { status: 200 },
        );
      }
    }

    return await withSettlementOperationLock(lockKey, async () => {
      // ロック内で再チェック（レース対策）。先に確定した側の値をそのまま返す。
      if (idemKey) {
        const raced = await prisma.settlement.findUnique({ where: { idempotencyKey: idemKey } });
        if (raced) {
          return corsJson(
            confirmedSettlementResponse(raced, effectivePrintMode, String(locationName ?? "")),
            { status: 200 },
          );
        }
      }

      // 点検レシートは 0 円で保存し、集計の結果を使わない（Issue #20）ので集計しない。
      // 精算は集計を 1 回だけにし、その結果で売上サマリーのキャッシュを更新する
      // （以前は computeAndCacheDailySummary の中でもう一度集計していた）。
      const preview = inspection
        ? null
        : await buildSettlementPreview(
            admin,
            shop.id,
            String(locationId),
            String(locationName ?? ""),
            String(targetDate),
          );

      if (preview) {
        try {
          await upsertDailySummaryCacheFromPreview(
            shop.id,
            String(locationId),
            String(targetDate),
            preview,
          );
        } catch {
          /* キャッシュ更新失敗は精算結果に影響させない */
        }
      }

      let sourceOrderId: string | null = null;
      let sourceOrderName: string | null = null;
      let settlementOrderSkipped = false;

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
        settlementOrderSkipped = sync.settlementOrderSkipped;
      }

      const settlement = await prisma.settlement.create({
        data: {
          shopId: shop.id,
          locationId: String(locationId),
          sourceOrderId,
          sourceOrderName,
          targetDate: String(targetDate),
          periodLabel: inspection ? `点検_${String(targetDate)}` : String(targetDate),
          currency: preview ? preview.currency : await resolveInspectionCurrency(shop.id),
          total: preview?.total ?? 0,
          netSales: preview?.netSales ?? 0,
          tax: preview?.tax ?? 0,
          discounts: preview?.discounts ?? 0,
          vipPointsUsed: preview?.vipPointsUsed ?? 0,
          refundTotal: preview?.refundTotal ?? 0,
          orderCount: preview?.orderCount ?? 0,
          refundCount: preview?.refundCount ?? 0,
          itemCount: preview?.itemCount ?? 0,
          voucherChangeAmount: preview?.voucherChangeAmount ?? 0,
          paymentSectionsJson: JSON.stringify(preview?.paymentSections ?? []),
          printMode: effectivePrintMode,
          status: "completed",
          idempotencyKey: idemKey,
        },
      });

      const printPayload =
        effectivePrintMode === "cloudprnt_direct" && preview
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
          settlementOrderSkipped,
          printMode: effectivePrintMode,
          targetDate: String(targetDate),
          isInspection: inspection,
          ...(printPayload !== undefined && { printPayload }),
        },
        { status: 201 },
      );
    });
  } catch (err) {
    if (err instanceof UpstreamAggregationError) {
      return corsErrorJson(
        request,
        { ok: false, error: err.message, code: err.code },
        500,
      );
    }
    if (err instanceof SpecialRefundPendingError) {
      return corsErrorJson(request, { ok: false, error: err.message, code: err.code }, 409);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("混み合っています") ? 429 : 500;
    return corsErrorJson(request, { ok: false, error: message }, status);
  }
}
