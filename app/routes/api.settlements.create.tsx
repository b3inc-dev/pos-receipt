/**
 * POST /api/settlements/create
 * 要件書 §21.3: 精算実行・保存
 *
 * 印字は shopify.printing に統一。SETTLEMENT / INSPECTION 注文は作らない（#22・#53）。
 * 保存済み Location.printMode が order_based / cloudprnt_direct でも旧経路は復活しない。
 * 冪等キーは shopId:locationId:targetDate（旧 printMode 付きキーも検索し、精算行を増やさない）。
 *
 * - isInspection=true: 点検レシート。1 日に何回でも発行できる（T 決定 2026-11-22）。冪等キーを付けず、
 *   発行ごとに 1 行を作り、その時点の金額と支払方法別内訳を残す。精算（確定）としては扱わない。
 *   返金処理中（pending）の特殊返金があっても止めず、warning を返す（T の決定 2026-11-23 4:25）
 * - 確定済みの日をもう一度押されたら、集計し直さず DB の確定値を preview として返す
 *   （T の決定「確定値を守る」2026-11-22・Issue #20）
 * - reconfirm=true: 確定済みの日を集計し直し、数が変わっていれば確定値を新しくする（前の行は superseded）
 * Shopify 同期は GAS Script Lock 相当の DB ロックで直列化。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { buildSettlementPreview } from "../services/settlementEngine.server";
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
import {
  UNIFIED_PRINT_MODE,
  allSettlementIdempotencyKeys,
  buildSettlementIdempotencyKey,
} from "../services/printUnification.server";
import {
  buildSettlementPrintSnapshot,
  encodePaymentSectionsJson,
  parsePaymentSectionsJson,
} from "../services/settlementPrintSnapshot.server";
import { UpstreamAggregationError } from "../services/settlementUpstreamPage.server";
import { SpecialRefundPendingError } from "../services/specialRefundOverlayPure.server";
import { normalizeLocationGidOrRaw } from "../utils/locationGid";

/** その日の確定済み精算（再確定前の superseded 行・点検の行は除く） */
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
      NOT: [{ periodLabel: { startsWith: "点検_" } }, { status: SUPERSEDED_SETTLEMENT_STATUS }],
    },
    orderBy: { createdAt: "desc" },
  });
}

type SettlementRow = NonNullable<Awaited<ReturnType<typeof findExistingDailySettlement>>>;

async function locationNameFor(shopId: string, locationId: string, fallback: string) {
  const gid = normalizeLocationGidOrRaw(locationId);
  const loc = await prisma.location.findFirst({
    where: { shopId, shopifyLocationGid: gid },
  });
  return loc?.displayName ?? loc?.name ?? fallback;
}

/** 点検の応答に付ける警告（返金処理中の特殊返金は数に入っていない） */
function pendingSpecialRefundWarning(labels: string[]): string {
  const shown = labels.slice(0, 5).join("、");
  const more = labels.length > 5 ? ` ほか ${labels.length - 5} 件` : "";
  return (
    `返金処理中の返金方法変更があります（注文: ${shown}${more}）。この返金は点検の金額に入っていません。` +
    "精算（確定）の前に、POS の「返金方法変更」タイルでその注文を開き、「返金を確かめる」を押してください（自動の確定をオンにした店では、数分たつと自動で読み直します）。"
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

    const inspection = Boolean(isInspection);
    const reconfirm = !inspection && body.reconfirm === true;
    const lockKey = buildSettlementLockKey(
      shop.id,
      String(locationId),
      String(targetDate),
      inspection ? "inspection" : "settlement",
    );

    /**
     * 確定済みの精算をもう一度押されたときの応答（T の決定「確定値を守る」）。
     * 集計し直さず、DB に保存した値をそのまま返す。
     */
    const confirmedSettlementBody = async (existing: SettlementRow) => {
      const locNameNow = await locationNameFor(shop.id, String(locationId), String(locationName ?? ""));
      const savedName =
        parsePaymentSectionsJson(existing.paymentSectionsJson).snapshot?.locationName?.trim() ||
        locNameNow;
      return {
        ok: true,
        idempotent: true,
        /** 確定済みの値（DB）を返したことを示す。集計し直した値ではない */
        confirmed: true,
        settlementId: existing.id,
        preview: settlementRowToPreview(existing, savedName),
        sourceOrderId: existing.sourceOrderId,
        sourceOrderName: existing.sourceOrderName,
        printMode: UNIFIED_PRINT_MODE,
        targetDate: existing.targetDate,
        isInspection: false,
      };
    };

    if (!inspection && !reconfirm) {
      const existingSettlement = await findExistingDailySettlement(
        shop.id,
        String(locationId),
        String(targetDate),
      );
      if (existingSettlement) {
        return corsJson(await confirmedSettlementBody(existingSettlement), { status: 200 });
      }
    }

    return await withSettlementOperationLock(lockKey, async () => {
      // ロック内で再チェック（レース対策）。先に確定した側の値をそのまま返す。
      const raced = !inspection
        ? await findExistingDailySettlement(shop.id, String(locationId), String(targetDate))
        : null;
      if (raced && !reconfirm) {
        return corsJson(await confirmedSettlementBody(raced), { status: 200 });
      }

      // 集計は 1 回だけにし、その結果で売上サマリーのキャッシュも更新する。
      // 点検は返金処理中（pending）の特殊返金があっても止めずに警告を返す。精算の確定・再確定は止める（D18）。
      const preview = await buildSettlementPreview(
        admin,
        shop.id,
        String(locationId),
        String(locationName ?? ""),
        String(targetDate),
        { allowPendingSpecialRefunds: inspection },
      );
      const pendingLabels = preview.pendingSpecialRefundOrderLabels ?? [];

      // 再確定で数が変わっていなければ、前の確定値のまま返す（行は変えない）
      if (raced && reconfirm) {
        const diff = diffConfirmedVsLive(settlementRowToPreview(raced, ""), preview);
        if (diff.changedFields.length === 0) {
          return corsJson(
            { ...(await confirmedSettlementBody(raced)), reconfirmed: false },
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

      const idemKey = !inspection
        ? buildSettlementIdempotencyKey(shop.id, String(locationId), String(targetDate))
        : null;

      const issuedLocationName = await locationNameFor(
        shop.id,
        String(locationId),
        String(preview.locationName || locationName || ""),
      );
      const printSnapshot = buildSettlementPrintSnapshot({
        locationName: issuedLocationName,
        isInspection: inspection,
        // 確定済みの日を確定し直した精算（再精算）。印字の「再精算」の印にだけ使う
        isResettlement: !inspection && !!raced,
      });

      const data = {
        shopId: shop.id,
        locationId: String(locationId),
        sourceOrderId: null,
        sourceOrderName: null,
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
        paymentSectionsJson: encodePaymentSectionsJson(preview.paymentSections, printSnapshot),
        printMode: UNIFIED_PRINT_MODE,
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

      return corsJson(
        {
          ok: true,
          idempotent: false,
          settlementId: settlement.id,
          preview: { ...preview, locationName: issuedLocationName },
          sourceOrderId: null,
          sourceOrderName: null,
          printMode: UNIFIED_PRINT_MODE,
          targetDate: String(targetDate),
          isInspection: inspection,
          ...(raced ? { reconfirmed: true, previousSettlementId: raced.id } : {}),
          ...(pendingLabels.length > 0
            ? { warning: pendingSpecialRefundWarning(pendingLabels) }
            : {}),
        },
        { status: 201 },
      );
    });
  } catch (err) {
    if (err instanceof UpstreamAggregationError) {
      return corsErrorJson(request, { ok: false, error: err.message, code: err.code }, 500);
    }
    if (err instanceof SpecialRefundPendingError) {
      return corsErrorJson(request, { ok: false, error: err.message, code: err.code }, 409);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("混み合っています") ? 429 : 500;
    return corsErrorJson(request, { ok: false, error: message }, status);
  }
}
