/**
 * 会計の前に入れた商品券の額面から、注文ができたあとに商品券調整を自動で登録する。
 *
 * 流れ（docs/VOUCHER_CART_ENTRY.md）:
 *   1. POS「商品券」タイルで、会計の前に額面を入れる → カートの見えない項目 `_pos_receipt_voucher_face` に入る
 *   2. 会計すると、その項目は注文の customAttributes に残る（shopify.dev: 「_」始まりは POS・レシートに出ないが注文に書かれる）
 *   3. 会計後の画面（pos.purchase.post.block.render）が POST /api/voucher-adjustments/from-cart を呼ぶ
 *      → この関数が注文を読み直し、タイルから後で登録したときと同じ記録（SpecialRefundEvent・pos.adjustments）を作る
 *   4. 会計後の画面を閉じてしまったときは、orders/updated の知らせ（note_attributes に項目があるとき）でも呼ぶ
 *
 * 同じ注文で 2 回作らない: 行の id を注文ごとに決まった値（pos_vc_cart_<注文の数字>）にして、主キーで止める。
 * 手で登録した商品券調整が先にあれば、自動では作らない。
 */
import prisma from "../db.server";
import { adminGraphqlWithRetry, type AdminGraphqlClient } from "../lib/shopifyGraphqlThrottle.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { getAppSetting, VOUCHER_SETTINGS_KEY, DEFAULT_VOUCHER_SETTINGS, type VoucherSettings } from "../utils/appSettings.server";
import { fetchOrderVoucherApplied, syncOrderAdjustmentsMetafield } from "./orderAdjustments.server";
import { toOrderGid, voucherChangeOf } from "./orderAdjustmentsPure.server";
import { refreshDailySummaryForAdjustment } from "./orderAdjustmentEdit.server";
import {
  VOUCHER_CART_FACE_KEY,
  parseVoucherCartFace,
  voucherCartFaceFromAttributes,
  voucherCartEventId,
  webhookPayloadHasVoucherCartFace,
} from "./voucherCartEntryPure";

export { VOUCHER_CART_FACE_KEY, parseVoucherCartFace, voucherCartFaceFromAttributes, voucherCartEventId, webhookPayloadHasVoucherCartFace };

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const ORDER_CART_ENTRY_QUERY = `#graphql
  query OrderVoucherCartEntry($id: ID!) {
    order(id: $id) {
      id
      name
      cancelledAt
      currencyCode
      customAttributes { key value }
      retailLocation { id }
    }
  }
`;

export type VoucherCartAutoResult =
  | { status: "created"; event: { id: string; voucherFaceValue: number; voucherAppliedAmount: number; voucherChangeAmount: number; sourceOrderName: string | null } }
  | { status: "already"; event: { id: string; voucherFaceValue: number | null; voucherAppliedAmount: number | null; voucherChangeAmount: number | null; sourceOrderName: string | null } }
  | { status: "no_face" }
  | { status: "no_voucher_payment"; face: number }
  | { status: "cancelled" }
  | { status: "disabled" }
  | { status: "order_unreadable" };

/** 商品券の機能が管理画面で切られていれば作らない（商品券設定「商品券機能」「手動調整」） */
async function voucherEntryEnabled(shopId: string): Promise<boolean> {
  const saved = await getAppSetting<Partial<VoucherSettings>>(shopId, VOUCHER_SETTINGS_KEY);
  const s = { ...DEFAULT_VOUCHER_SETTINGS, ...(saved ?? {}) };
  return s.voucherFeatureEnabled !== false && s.voucherManualAdjustmentEnabled !== false;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "P2002");
}

async function findExistingVoucherEvent(shopId: string, orderGid: string) {
  const numeric = orderGid.replace(/\D/g, "");
  return prisma.specialRefundEvent.findFirst({
    where: {
      shopId,
      eventType: "voucher_change_adjustment",
      status: "active",
      sourceOrderId: { in: [orderGid, numeric] },
    },
    orderBy: { createdAt: "asc" },
  });
}

function existingResult(ev: NonNullable<Awaited<ReturnType<typeof findExistingVoucherEvent>>>): VoucherCartAutoResult {
  return {
    status: "already",
    event: {
      id: ev.id,
      voucherFaceValue: ev.voucherFaceValue == null ? null : Number(ev.voucherFaceValue),
      voucherAppliedAmount: ev.voucherAppliedAmount == null ? null : Number(ev.voucherAppliedAmount),
      voucherChangeAmount: ev.voucherChangeAmount == null ? null : Number(ev.voucherChangeAmount),
      sourceOrderName: ev.sourceOrderName,
    },
  };
}

/**
 * 注文に会計前の額面があれば、商品券調整を 1 件だけ登録する。
 * Shopify の返金はしない（商品券調整はいつも記録のみ）。
 */
export async function registerVoucherFromCartEntry(
  admin: AdminClient,
  shopId: string,
  sourceOrderId: string,
  opts: { createdBy?: string | null; locationId?: string | null } = {},
): Promise<VoucherCartAutoResult> {
  const orderGid = toOrderGid(sourceOrderId);
  if (!/\d/.test(orderGid)) return { status: "order_unreadable" };

  const existing = await findExistingVoucherEvent(shopId, orderGid);
  if (existing) return existingResult(existing);

  let order: {
    id: string;
    name?: string | null;
    cancelledAt?: string | null;
    currencyCode?: string | null;
    customAttributes?: { key: string; value?: string | null }[] | null;
    retailLocation?: { id?: string | null } | null;
  } | null = null;
  try {
    const json = await adminGraphqlWithRetry<{ errors?: unknown[]; data?: { order?: typeof order } }>(
      admin as AdminGraphqlClient,
      ORDER_CART_ENTRY_QUERY,
      { variables: { id: orderGid } },
      "orderVoucherCartEntry",
    );
    if (json.errors && json.errors.length > 0) return { status: "order_unreadable" };
    order = json.data?.order ?? null;
  } catch (err) {
    console.warn(`[voucher-cart-entry] order read failed: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "order_unreadable" };
  }
  if (!order) return { status: "order_unreadable" };

  const face = voucherCartFaceFromAttributes(order.customAttributes);
  if (face == null) return { status: "no_face" };
  if (order.cancelledAt) return { status: "cancelled" };
  if (!(await voucherEntryEnabled(shopId))) return { status: "disabled" };

  const info = await fetchOrderVoucherApplied(admin, shopId, orderGid);
  if (!info || info.applied == null || info.applied < 0) {
    // 商品券釣有りなどの商品券の支払いが無い（別の手段で払った）: 登録しない
    return { status: "no_voucher_payment", face };
  }
  const applied = info.applied;
  const change = voucherChangeOf(face, applied);

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  // 数える日は注文の日（後から登録したときと同じ）
  const countDate = getCalendarDateStringInTimeZone(
    info.orderCreatedAt ? new Date(info.orderCreatedAt) : new Date(),
    timezone,
  );
  const locationId = String(order.retailLocation?.id ?? opts.locationId ?? "");

  let event;
  try {
    event = await prisma.specialRefundEvent.create({
      data: {
        id: voucherCartEventId(orderGid),
        shopId,
        sourceOrderId: orderGid,
        sourceOrderName: order.name ?? info.orderName ?? null,
        locationId,
        eventType: "voucher_change_adjustment",
        amount: change,
        currency: order.currencyCode ?? "JPY",
        voucherFaceValue: face,
        voucherAppliedAmount: applied,
        voucherChangeAmount: change,
        note: "会計の前に入れた額面",
        createdBy: opts.createdBy ? String(opts.createdBy) : null,
        status: "active",
        shopifyRefundStatus: "skipped",
        countDate,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // 会計後の画面と注文更新の知らせが同時に来た: 先に作った方を返す
      const again = await findExistingVoucherEvent(shopId, orderGid);
      if (again) return existingResult(again);
    }
    throw err;
  }

  await syncOrderAdjustmentsMetafield(admin, shopId, event.sourceOrderId);
  await refreshDailySummaryForAdjustment(admin, shopId, event.locationId, countDate);

  return {
    status: "created",
    event: {
      id: event.id,
      voucherFaceValue: face,
      voucherAppliedAmount: applied,
      voucherChangeAmount: change,
      sourceOrderName: event.sourceOrderName,
    },
  };
}
