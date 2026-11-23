/**
 * POST /api/settlements/create
 * 要件書 §21.3: 精算実行・保存
 *
 * - cloudprnt_direct: 集計してDB保存 → printable payload を返す
 * - order_based: 集計 → Shopify精算注文作成（GAS newSettlementFresh 相当）→ DB保存
 * - isInspection=true: 点検レシート（GAS uiCreateZeroInspection 相当）。発行ごとにその時点の金額と
 *   支払方法別内訳を保存する（T の決定・#78 と同じ形）。精算（確定）としては扱わない。
 *   返金処理中（pending）の特殊返金があっても止めず、warning を返す（T の決定 2026-11-23 4:25）
 * - reconfirm=true: 確定済みの日を集計し直し、数が変わっていれば確定値を新しくする（前の行は superseded）
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
import {
  diffConfirmedVsLive,
  settlementRowToPreview,
  SUPERSEDED_SETTLEMENT_STATUS,
} from "../services/settlementConfirmedPure.server";
import {
  buildSettlementLockKey,
  withSettlementOperationLock,
} from "../services/settlementLock.server";
import { resolveSettlementOrderSyncOptions } from "../services/settlementSyncSettings.server";
import { UpstreamAggregationError } from "../services/settlementUpstreamPage.server";
import { SpecialRefundPendingError } from "../services/specialRefundOverlayPure.server";
import { normalizeLocationGidOrRaw } from "../utils/locationGid";

/** locationId + targetDate + printMode から冪等キーを生成 */
function buildIdempotencyKey(
  shopId: string,
  locationId: string,
  targetDate: string,
  printMode: string,
): string {
  return `${shopId}:${locationId}:${targetDate}:${printMode}`;
}

async function resolveEffectivePrintMode(shopId: string, locationId: string): Promise<string> {
  const gid = normalizeLocationGidOrRaw(locationId);
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

/** 点検の応答に付ける警告（返金処理中の特殊返金は数に入っていない） */
function pendingSpecialRefundWarning(labels: string[]): string {
  const shown = labels.slice(0, 5).join("、");
  const more = labels.length > 5 ? ` ほか ${labels.length - 5} 件` : "";
  return (
    `返金処理中の特殊返金があります（注文: ${shown}${more}）。この返金は点検の金額に入っていません。` +
    "精算（確定）の前に、POS の特殊返金で「返金を確かめる」を押してください（自動の確定をオンにした店では、数分たつと自動で読み直します）。"
  );
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
    // reconfirm: true のときだけ、集計し直して数が変わっていれば確定値を新しくする
    // （T の決定 2026-11-23 4:20。前の確定値は status=superseded で履歴に残す）。
    const reconfirm = !inspection && body.reconfirm === true;
    const idemKey = !inspection
      ? buildIdempotencyKey(shop.id, String(locationId), String(targetDate), effectivePrintMode)
      : null;
    if (idemKey && !reconfirm) {
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
      const raced = idemKey
        ? await prisma.settlement.findUnique({ where: { idempotencyKey: idemKey } })
        : null;
      if (raced && !reconfirm) {
        return corsJson(
          confirmedSettlementResponse(raced, effectivePrintMode, String(locationName ?? "")),
          { status: 200 },
        );
      }

      // 集計は 1 回だけにし、その結果で売上サマリーのキャッシュも更新する
      // （以前は computeAndCacheDailySummary の中でもう一度集計していた）。
      // 点検は毎回その時点の金額を残す（T の決定）。返金処理中（pending）の特殊返金があっても
      // 点検は止めずに警告を返す（T の決定 2026-11-23 4:25）。精算の確定・再確定は止める（D18）。
      const preview = await buildSettlementPreview(
        admin,
        shop.id,
        String(locationId),
        String(locationName ?? ""),
        String(targetDate),
        { allowPendingSpecialRefunds: inspection },
      );
      const pendingLabels = preview.pendingSpecialRefundOrderLabels ?? [];

      // 再確定で数が変わっていなければ、前の確定値のまま返す（行も Shopify も変えない）
      if (raced && reconfirm) {
        const diff = diffConfirmedVsLive(settlementRowToPreview(raced, ""), preview);
        if (diff.changedFields.length === 0) {
          return corsJson(
            {
              ...confirmedSettlementResponse(raced, effectivePrintMode, String(locationName ?? "")),
              reconfirmed: false,
            },
            { status: 200 },
          );
        }
      }

      // pending があるときは、数に入っていない返金があるのでキャッシュを書かない（D18 と同じ考え）
      if (pendingLabels.length === 0) {
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
        // 再確定のときも同じ日の精算注文を新しい値に直す（DB と Shopify をそろえる）
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

      const data = {
        shopId: shop.id,
        locationId: String(locationId),
        sourceOrderId,
        sourceOrderName,
        targetDate: String(targetDate),
        periodLabel: inspection ? `点検_${String(targetDate)}` : String(targetDate),
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
      };

      // 再確定: 前の行は冪等キーを外して superseded にし（履歴に残る）、新しい行を確定値にする
      const settlement = raced
        ? (
            await prisma.$transaction([
              prisma.settlement.update({
                where: { id: raced.id },
                data: { status: SUPERSEDED_SETTLEMENT_STATUS, idempotencyKey: null },
              }),
              prisma.settlement.create({ data }),
            ])
          )[1]
        : await prisma.settlement.create({ data });

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
          settlementOrderSkipped,
          printMode: effectivePrintMode,
          targetDate: String(targetDate),
          isInspection: inspection,
          ...(raced ? { reconfirmed: true, previousSettlementId: raced.id } : {}),
          ...(pendingLabels.length > 0
            ? { warning: pendingSpecialRefundWarning(pendingLabels) }
            : {}),
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
