/**
 * 特殊返金「支払方法の付け替え」の承認／却下（管理画面の特殊返金履歴から）。
 * Shopify には何も書かない。決めたら登録日の売上サマリーの日次キャッシュを計算し直す。
 * 決め方の約束は ../utils/specialRefundApproval.ts。
 */
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "./salesSummaryEngine.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { normalizeLocationGid } from "../utils/locationGid";
import { checkApprovalDecision } from "../utils/specialRefundApproval";
import { SUPERSEDED_SETTLEMENT_STATUS } from "./settlementConfirmedPure.server";
import { syncOrderAdjustmentsMetafield } from "./orderAdjustments.server";
import { countDateOf } from "./orderAdjustmentsPure.server";

type AdminClient = Parameters<typeof computeAndCacheDailySummary>[0];

export type SpecialRefundApprovalResult =
  | {
      ok: true;
      decision: "approved" | "rejected";
      eventId: string;
      sourceOrderName: string | null;
      /** 登録日の精算がもう確定している（確定した金額は変わらない） */
      settlementAlreadyConfirmed: boolean;
    }
  | { ok: false; code: string; message: string };

export async function decideSpecialRefundApproval(
  admin: AdminClient,
  shopId: string,
  eventId: string,
  decision: unknown,
): Promise<SpecialRefundApprovalResult> {
  const event = await prisma.specialRefundEvent.findFirst({ where: { id: eventId, shopId } });
  if (!event) return { ok: false, code: "NOT_FOUND", message: "登録が見つかりません。画面を読み直してください。" };
  const check = checkApprovalDecision(event, decision);
  if (!check.ok) return check;

  // 二人が同時に押したとき、後の人は「承認待ちではありません」にする（承認待ちのときだけ書き換える）
  const updated = await prisma.specialRefundEvent.updateMany({
    where: { id: event.id, shopId, status: "active", approvalStatus: "pending" },
    data: { approvalStatus: check.next, approvalReviewedAt: new Date() },
  });
  if (updated.count !== 1) {
    return {
      ok: false,
      code: "NOT_PENDING",
      message: "この登録は承認待ちではありません（ほかの人が先に決めた可能性があります）。画面を読み直してください。",
    };
  }

  // 注文メタフィールド pos.adjustments の status（承認待ち → 有効／却下）を書き直す（失敗しても決定は取り消さない）
  await syncOrderAdjustmentsMetafield(admin, shopId, event.sourceOrderId);

  let settlementAlreadyConfirmed = false;
  const locationGid = normalizeLocationGid(event.locationId);
  if (locationGid) {
    try {
      const timezone = await getShopTimezoneForDaily(admin, shopId);
      const targetDate = countDateOf(event, timezone);
      const locIdRaw = locationGid.replace("gid://shopify/Location/", "");
      const settlements = await prisma.settlement.findMany({
        where: {
          shopId,
          locationId: { in: [locationGid, locIdRaw] },
          targetDate,
          status: { in: ["completed", "printed"] },
        },
        select: { periodLabel: true, status: true },
      });
      settlementAlreadyConfirmed = settlements.some(
        (s) => !s.periodLabel?.startsWith("点検_") && s.status !== SUPERSEDED_SETTLEMENT_STATUS,
      );
      const loc = await prisma.location.findFirst({
        where: { shopId, shopifyLocationGid: locationGid },
        select: { name: true },
      });
      await computeAndCacheDailySummary(admin, shopId, locationGid, loc?.name ?? "", targetDate);
    } catch (err) {
      // 売上サマリーのキャッシュは次の計算で直る。承認／却下は取り消さない
      console.warn(
        `[special-refund-approval] daily summary refresh failed shop=${shopId} event=${event.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    ok: true,
    decision: check.next,
    eventId: event.id,
    sourceOrderName: event.sourceOrderName,
    settlementAlreadyConfirmed,
  };
}
