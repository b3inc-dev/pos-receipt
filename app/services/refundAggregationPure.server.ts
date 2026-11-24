/**
 * 返金計上ロケーション解決の純関数（DB / Shopify 非依存）。
 * settlementEngine のユニットテストから prisma なしで import できるように分離。
 */

import { normalizeLocationGid, extractLocationNumericId } from "../utils/locationGid";

export type RefundAggregationLocationMode =
  | "order_transaction"
  | "refund_transaction_pos_location";

export type NonPosRefundFallbackMode = "order_retail_location" | "exclude";

export interface RefundAggregationContext {
  mode: RefundAggregationLocationMode;
  nonPosRefundFallbackMode: NonPosRefundFallbackMode;
  /** ショップ内で1件のみ: nonPosRefundAttributionEnabled のロケーション GID */
  nonPosRefundTargetLocationGid: string | null;
}

export interface OrderForRefundAggregation {
  id: string;
  retailLocation?: { id: string } | null;
  transactions?: Array<{
    id?: string;
    kind?: string;
    createdAt?: string;
    location?: { id: string } | null;
  }>;
  refunds?: Array<{
    /** 返金の GID（Shopify の refund.id）。特殊返金の登録と照らすのに使う */
    id?: string;
    createdAt?: string;
    transactions?: Array<{
      id?: string;
      kind?: string;
      location?: { id: string } | null;
    }>;
  }>;
}

/** GID 正規化（本体は app/utils/locationGid.ts。既存の import 先を変えないために再公開） */
export { normalizeLocationGid, extractLocationNumericId };

/**
 * 精算対象ロケーションと返金計上 GID が一致するか。
 * 比較は常に数値 ID 同士（GID / 数値 / 末尾パスの表記ゆれを吸収）。
 * settlementLocationId・locIdRaw のどちらからでも数値を復元できれば照合する。
 */
export function locationGidMatches(
  aggregationGid: string | null | undefined,
  settlementLocationId: string,
  locIdRaw?: string | null,
): boolean {
  const aggRaw = extractLocationNumericId(aggregationGid);
  if (!aggRaw) return false;

  const settlementRaw =
    extractLocationNumericId(settlementLocationId) ??
    (locIdRaw && /^\d+$/.test(String(locIdRaw).trim()) ? String(locIdRaw).trim() : null);

  if (!settlementRaw) return false;
  return aggRaw === settlementRaw;
}

/** 返金トランザクション（refunds 配下）から POS ロケーション ID を取得 */
export function getPosLocationFromRefundTransactions(
  order: OrderForRefundAggregation,
  inDay?: (iso?: string) => boolean,
): string | null {
  let latest: { ts: number; locationId: string } | null = null;

  for (const refund of order.refunds ?? []) {
    if (inDay && !inDay(refund.createdAt)) continue;
    const txs = refund.transactions ?? [];
    const nodes = Array.isArray(txs)
      ? txs
      : (txs as { nodes?: typeof txs }).nodes ?? [];

    for (const tx of nodes) {
      if (String(tx.kind ?? "").toUpperCase() !== "REFUND") continue;
      const locId = tx.location?.id;
      if (!locId) continue;
      const ts = refund.createdAt ? new Date(refund.createdAt).getTime() : 0;
      if (!latest || ts >= latest.ts) {
        latest = { ts, locationId: locId };
      }
    }
  }

  return latest ? normalizeLocationGid(latest.locationId) : null;
}

/** 注文に当日の返金があるか */
export function orderHasRefundInDay(
  order: OrderForRefundAggregation,
  inDay: (iso?: string) => boolean,
): boolean {
  for (const r of order.refunds ?? []) {
    if (inDay(r.createdAt)) return true;
  }
  for (const tx of order.transactions ?? []) {
    if (String(tx.kind ?? "").toUpperCase() === "REFUND" && inDay(tx.createdAt)) return true;
  }
  return false;
}

/**
 * 注文の返金をどのロケーションの精算に載せるかを決定する。
 */
export function resolveRefundAggregationLocationGid(
  order: OrderForRefundAggregation,
  ctx: RefundAggregationContext,
  inDay?: (iso?: string) => boolean,
): string | null {
  const retailGid = normalizeLocationGid(order.retailLocation?.id);
  const refundPosGid = getPosLocationFromRefundTransactions(order, inDay);

  if (ctx.mode === "refund_transaction_pos_location" && refundPosGid) {
    return refundPosGid;
  }

  if (refundPosGid) {
    // モードが order_transaction でも返金 TX に POS ロケーションがあれば注文基準で retail と同系
    return retailGid ?? refundPosGid;
  }

  // POS ロケーションが付かない返金（管理画面等）
  return resolveNonPosRefundFallbackGid(order, ctx);
}

/**
 * 店の付かない返金（管理画面・外部・アプリの refundCreate）を、注文の metafield が無いときに数える店。
 * 「POS 以外の返金の計上先」の店 → （「数えない」なら null）→ 販売店。
 */
export function resolveNonPosRefundFallbackGid(
  order: Pick<OrderForRefundAggregation, "retailLocation">,
  ctx: RefundAggregationContext,
): string | null {
  if (ctx.nonPosRefundTargetLocationGid) {
    return ctx.nonPosRefundTargetLocationGid;
  }
  if (ctx.nonPosRefundFallbackMode === "exclude") {
    return null;
  }
  return normalizeLocationGid(order.retailLocation?.id);
}

type RefundTxLike = { kind?: string; location?: { id: string } | null };

/** 返金に、店の付いた返金 TX（REFUND）が 1 つでもあるか */
export function refundHasPosLocation(refund: {
  transactions?: RefundTxLike[] | { nodes?: RefundTxLike[] } | null;
}): boolean {
  const txs = refund.transactions ?? [];
  const nodes = Array.isArray(txs) ? txs : (txs.nodes ?? []);
  return nodes.some((tx) => String(tx.kind ?? "").toUpperCase() === "REFUND" && !!tx.location?.id);
}

/** 特殊返金の登録のうち、Shopify で返金した記録（返金の照合に使う分だけ） */
export interface SpecialRefundForAggregation {
  locationId: string;
  shopifyRefundId: string | null;
  createdAt?: Date | string | null;
}

function refundNumericId(id: string | null | undefined): string | null {
  const m = String(id ?? "").match(/(\d+)\s*$/);
  return m ? m[1] : null;
}

/**
 * 注文の「店の付かない返金」のうち一番新しいものが、このアプリの特殊返金で Shopify に作った返金なら、
 * その特殊返金を登録した店を返す（metafield に書く値。#119 見直し P2-A）。
 * それ以外（POS の返金だけ・管理画面の返金が最後・特殊返金の照合ができない）は null（今までどおり resolve）。
 *
 * 特殊返金を登録した店は登録の API が metafield に書くが、そのあとの orders/updated の同期が resolve
 * （店の付かない返金なら「POS 以外の返金の計上先」か販売店）で書き戻すと、返金した店で数えなくなるため。
 * 無効にした行・「変更」で置き換えた行も、同じ返金 ID なら返金した店は同じなので照合に使う。
 */
export function specialRefundLocationForLatestNonPosRefund(
  order: Pick<OrderForRefundAggregation, "refunds">,
  events: readonly SpecialRefundForAggregation[],
): string | null {
  let latest: { ts: number; id: string } | null = null;
  for (const refund of order.refunds ?? []) {
    if (refundHasPosLocation(refund)) continue;
    const id = refundNumericId(refund.id);
    if (!id) continue;
    const ts = refund.createdAt ? new Date(refund.createdAt).getTime() : 0;
    if (!latest || ts >= latest.ts) latest = { ts, id };
  }
  if (!latest) return null;

  let picked: { ts: number; gid: string } | null = null;
  for (const e of events) {
    if (refundNumericId(e.shopifyRefundId) !== latest.id) continue;
    const gid = normalizeLocationGid(e.locationId);
    if (!gid) continue;
    const ts = e.createdAt ? new Date(e.createdAt).getTime() : 0;
    if (!picked || ts >= picked.ts) picked = { ts, gid };
  }
  return picked?.gid ?? null;
}

/** ロケーション保存時: nonPosRefundAttributionEnabled はショップ内1件のみ */
export function validateNonPosRefundAttributionLocations(
  locations: { id: string; nonPosRefundAttributionEnabled?: boolean }[],
): string | null {
  const enabled = locations.filter((l) => l.nonPosRefundAttributionEnabled === true);
  if (enabled.length > 1) {
    return "「POSロケーション以外の返金の計上先」は1つのロケーションだけにしてください。";
  }
  return null;
}
