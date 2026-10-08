/**
 * 返金計上ロケーション解決の純関数（DB / Shopify 非依存）。
 * settlementEngine のユニットテストから prisma なしで import できるように分離。
 */

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
    createdAt?: string;
    transactions?: Array<{
      id?: string;
      kind?: string;
      location?: { id: string } | null;
    }>;
  }>;
}

/** GID 正規化 */
export function normalizeLocationGid(locationId: string | null | undefined): string | null {
  const s = String(locationId ?? "").trim();
  if (!s) return null;
  if (s.startsWith("gid://shopify/Location/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ? `gid://shopify/Location/${m[1]}` : null;
}

export function extractLocationNumericId(locationId: string | null | undefined): string | null {
  const gid = normalizeLocationGid(locationId);
  if (!gid) return null;
  return gid.replace("gid://shopify/Location/", "");
}

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
  if (ctx.nonPosRefundTargetLocationGid) {
    return ctx.nonPosRefundTargetLocationGid;
  }

  if (ctx.nonPosRefundFallbackMode === "exclude") {
    return null;
  }

  return retailGid;
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
