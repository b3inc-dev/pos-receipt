/**
 * 精算集計の純関数（DB / Shopify 非依存）。
 * Phase 1 ユニットテスト用に settlementEngine から切り出し。挙動は元実装と同一。
 */
import {
  locationGidMatches,
  normalizeLocationGid,
  resolveRefundAggregationLocationGid,
  type RefundAggregationContext,
} from "./refundAggregationPure.server";

export type GasAggregateAttributionOpts = {
  attributionCtx: RefundAggregationContext;
  settlementLocationId: string;
  locIdRaw: string;
};

export type GasPayBucket = {
  sale: number;
  refund: number;
  saleTx: number;
  refundTx: number;
};

/** aggregateGasStyleForOrders が参照する注文形状（Shopify 応答の部分集合） */
export interface GasStyleOrder {
  id: string;
  note?: string | null;
  cancelledAt?: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode?: string } };
  currentTotalTaxSet?: { shopMoney: { amount: string } } | null;
  totalTaxSet?: { shopMoney: { amount: string } };
  lineItems?: {
    nodes: {
      quantity: number;
      discountAllocations?: {
        allocatedAmountSet: { shopMoney: { amount: string } };
        discountApplication?: {
          __typename: string;
          code?: string | null;
          title?: string | null;
        } | null;
      }[];
    }[];
  };
  transactions?: Array<{
    id: string;
    createdAt?: string;
    kind: string;
    amountSet?: { shopMoney: { amount: string; currencyCode?: string } };
    gateway?: string;
    formattedGateway?: string | null;
  }>;
  refunds?: Array<{
    createdAt?: string;
    refundLineItems?: { quantity: number }[];
    transactions?: Array<{
      id: string;
      kind?: string;
      gateway?: string;
      formattedGateway?: string | null;
      amountSet?: { shopMoney: { amount: string; currencyCode?: string } };
      location?: { id: string } | null;
    }>;
  }>;
  retailLocation?: { id: string } | null;
  /** pos.refund_aggregation_location_gid（集計時優先。無ければ resolve） */
  refundAggregationLocationGid?: string | null;
}

export const GAS_UNKNOWN_GATEWAY = "未分類";
export const GAS_GATEWAY_CASH = "現金";

export function ensurePayBucket(
  pay: Record<string, GasPayBucket>,
  key: string,
): void {
  if (!pay[key]) pay[key] = { sale: 0, refund: 0, saleTx: 0, refundTx: 0 };
}

/** docs/GAS_精算レシート.md の normalizeGatewayLabel に合わせる */
export function gasNormalizeGatewayLabel(
  gateway: string,
  formattedGateway?: string | null,
): string {
  const raw = String(gateway ?? "").trim().toLowerCase();
  const fmt = String(formattedGateway ?? "").trim().toLowerCase();
  const s = `${raw} ${fmt}`.trim();
  if (!s) return GAS_UNKNOWN_GATEWAY;

  const isGift =
    raw === "gift_card" ||
    s.includes("giftcard") ||
    s.includes("gift_card") ||
    s.includes("gift ") ||
    s.includes("voucher") ||
    s.includes("gc") ||
    s.includes("商品券") ||
    s.includes("ギフトカード");

  const hasNoChangeHint =
    s.includes("釣無") ||
    s.includes("釣なし") ||
    s.includes("釣り無し") ||
    s.includes("つりなし") ||
    s.includes("nochange") ||
    s.includes("no change");

  const hasChangeHint =
    s.includes("釣有") ||
    s.includes("釣あり") ||
    s.includes("釣り有り") ||
    s.includes("つりあり") ||
    s.includes("change") ||
    s.includes("with_change") ||
    s.includes("chg") ||
    s.includes("釣銭") ||
    s.includes("おつり");

  if (isGift) {
    if (hasNoChangeHint && !hasChangeHint) return "商品券釣無し";
    if (hasChangeHint) return "商品券釣有り";
    return "商品券";
  }

  if (
    raw === "cash" ||
    raw === "cash_payment" ||
    raw === "manual" ||
    fmt === "現金" ||
    s.includes("現金決済")
  ) {
    return "現金";
  }

  if (raw === "credit_card" || raw === "card" || raw === "creditcard") return "クレジットカード";
  if (s.includes("credit") || s.includes("クレジット")) return "クレジットカード";

  if (s.includes("qr")) return "電子マネー(QR)";
  if (s.includes("edy") || s.includes("waon") || s.includes("nanaco")) return "電子マネー";

  if (
    s.includes("交通系") ||
    s.includes("suica") ||
    s.includes("pasmo") ||
    s.includes("toica") ||
    s.includes("icoca") ||
    s.includes("nimoca") ||
    s.includes("はやかけん") ||
    s.includes("kitaca") ||
    s.includes("icカード") ||
    s.includes("icｶｰﾄﾞ")
  ) {
    return "交通系ICカード決済";
  }

  if (s.includes("id") || s.includes("felica")) return "電子マネー";

  if (raw === "paypal" || s.includes("paypal")) return "PayPal";

  const rawFmt = String(formattedGateway ?? "").trim();
  const rawGw = String(gateway ?? "").trim();
  return rawFmt || rawGw || GAS_UNKNOWN_GATEWAY;
}

function gasTxLabel(tx: {
  gateway?: string;
  formattedGateway?: string | null;
}): string {
  return gasNormalizeGatewayLabel(tx.gateway ?? "", tx.formattedGateway);
}

/** GAS z2hDigits: 全角数字・読点を除いて半角化（商品券額面パース用） */
function z2hDigitsForVoucherNote(input: string): string {
  const digitMap: Record<string, string> = {
    "０": "0",
    "１": "1",
    "２": "2",
    "３": "3",
    "４": "4",
    "５": "5",
    "６": "6",
    "７": "7",
    "８": "8",
    "９": "9",
  };
  let s = "";
  for (const ch of String(input ?? "")) {
    s += digitMap[ch] ?? ch;
  }
  return s.replace(/[，、,]/g, "");
}

/** GAS parseVoucherFaceFromNote: 注文ノートの「商品券 2000円」等から額面を抽出 */
function parseVoucherFaceFromNote(note: string | null | undefined): number {
  const s = z2hDigitsForVoucherNote(note ?? "");
  const m = s.match(/商品券\s*([0-9]+)\s*(?:円|えん)?/);
  return m ? Number(m[1]) : 0;
}

export type RefundAttributionDecision = {
  /** 精算対象ロケに返金を載せるか */
  counts: boolean;
  /** metafield と resolve が両方あり不一致 */
  mismatch: boolean;
  /** 実際に使った計上 GID（metafield 優先） */
  usedGid: string | null;
  resolvedGid: string | null;
  metafieldGid: string | null;
};

/**
 * 返金計上ロケ: metafield 優先、無ければ resolve。
 * 不一致でも金額ロジックは metafield 側を使い、mismatch フラグのみ立てる。
 */
export function decideRefundAttributionForSettlement(
  order: GasStyleOrder,
  inRange: (iso?: string) => boolean,
  opts?: GasAggregateAttributionOpts,
): RefundAttributionDecision {
  if (!opts) {
    return {
      counts: true,
      mismatch: false,
      usedGid: null,
      resolvedGid: null,
      metafieldGid: null,
    };
  }
  const metafieldGid = normalizeLocationGid(order.refundAggregationLocationGid);
  const resolvedGid = resolveRefundAggregationLocationGid(
    order,
    opts.attributionCtx,
    inRange,
  );
  const mismatch = !!(metafieldGid && resolvedGid && metafieldGid !== resolvedGid);
  const usedGid = metafieldGid ?? resolvedGid;
  return {
    counts: locationGidMatches(usedGid, opts.settlementLocationId, opts.locIdRaw),
    mismatch,
    usedGid,
    resolvedGid,
    metafieldGid,
  };
}

export function orderRefundsCountForSettlement(
  order: GasStyleOrder,
  inRange: (iso?: string) => boolean,
  opts?: GasAggregateAttributionOpts,
): boolean {
  return decideRefundAttributionForSettlement(order, inRange, opts).counts;
}

/**
 * GAS aggregate の注文ループ（todaysTx・pay・refundsGross・割引/VIP 按分・税 Shopify 相当）。
 * ノート観測: observeVoucherChangeFromFace（キャンセル除外）・GAS cash cap（effectiveCashSale）。
 */
export function aggregateGasStyleForOrders(
  orders: GasStyleOrder[],
  inRange: (iso?: string) => boolean,
  attributionOpts?: GasAggregateAttributionOpts,
): {
  pay: Record<string, GasPayBucket>;
  refundsGross: number;
  discountsTotal: number;
  vipPointsUsed: number;
  saleOrderSet: Set<string>;
  refundOrderSet: Set<string>;
  itemCount: number;
  taxTotalShopify: number;
  /** GAS _voucher_change_total 相当（ノート・現金お釣りヒューリスティックの観測値のみ） */
  voucherChangeObserved: number;
  /** metafield と resolve の不一致件数（診断用。金額は metafield 優先） */
  refundAttributionMismatchCount: number;
} {
  const pay: Record<string, GasPayBucket> = {};
  let refundsGross = 0;
  let discountsTotal = 0;
  let vipPointsUsed = 0;
  const saleOrderSet = new Set<string>();
  const refundOrderSet = new Set<string>();
  let itemCount = 0;
  let taxTotalShopify = 0;
  let voucherChangeObserved = 0;
  let refundAttributionMismatchCount = 0;

  for (const o of orders) {
    const attribution = decideRefundAttributionForSettlement(o, inRange, attributionOpts);
    if (attribution.mismatch) refundAttributionMismatchCount += 1;
    const countRefundsForThisLocation = attribution.counts;

    const refundTxIdsInDay = new Set<string>();
    for (const r of o.refunds ?? []) {
      if (!inRange(r.createdAt)) continue;
      for (const e of r.transactions ?? []) {
        if (e?.id) refundTxIdsInDay.add(e.id);
      }
    }

    const txs = o.transactions ?? [];
    const todaysTx = txs.filter((tx) => {
      const byTime = inRange(tx.createdAt);
      const byRefundLink = refundTxIdsInDay.has(tx.id);
      return byTime || (String(tx.kind) === "REFUND" && byRefundLink);
    });

    let orderRefundToday = 0;
    const gwSaleMapToday: Record<string, number> = {};

    for (const tx of todaysTx) {
      const amt = Number(tx.amountSet?.shopMoney?.amount ?? 0);
      const kind = String(tx.kind ?? "");
      const gw = gasTxLabel(tx);
      ensurePayBucket(pay, gw);

      if (kind === "SALE" || kind === "CAPTURE") {
        gwSaleMapToday[gw] = (gwSaleMapToday[gw] || 0) + amt;
        pay[gw].saleTx += 1;
      } else if (kind === "REFUND") {
        if (!countRefundsForThisLocation) continue;
        const r = Math.abs(amt);
        orderRefundToday += r;
        pay[gw].refund += r;
        pay[gw].refundTx += 1;
        refundOrderSet.add(o.id);
      }
    }

    // GAS cash cap: effectiveCashSale = min(rawCash, max(0, orderFinal - nonCash))
    // 返金有無に関わらず常に適用（GAS observeGenericCashChange と同式）
    const rawCashSale = Number(gwSaleMapToday[GAS_GATEWAY_CASH] || 0);
    const nonCashSaleTotal = Object.entries(gwSaleMapToday)
      .filter(([k]) => k !== GAS_GATEWAY_CASH)
      .reduce((acc, [, v]) => acc + Number(v || 0), 0);
    const orderFinal = Number(o.totalPriceSet?.shopMoney?.amount ?? 0);
    let effectiveCashSale = rawCashSale;
    let orderVoucherCashChange = 0;
    if (rawCashSale > 0) {
      const neededCashForOrder = Math.max(0, orderFinal - nonCashSaleTotal);
      effectiveCashSale = Math.min(rawCashSale, neededCashForOrder);
      orderVoucherCashChange = Math.max(0, rawCashSale - effectiveCashSale);
    }
    const hasVoucherInNote = /商品券/.test(o.note ?? "");
    const hasVoucherInGateway = Object.keys(gwSaleMapToday).some((k) => /商品券/.test(k));
    for (const [gw, amt] of Object.entries(gwSaleMapToday)) {
      ensurePayBucket(pay, gw);
      pay[gw].sale += gw === GAS_GATEWAY_CASH ? effectiveCashSale : Number(amt);
    }
    const effectiveOrderSaleToday = nonCashSaleTotal + effectiveCashSale;

    const hasRefundObjToday = refundTxIdsInDay.size > 0;
    const hasRefundTxToday = todaysTx.some((tx) => String(tx.kind) === "REFUND");
    if (countRefundsForThisLocation && hasRefundObjToday && !hasRefundTxToday) {
      let amt = 0;
      let cnt = 0;
      for (const r of o.refunds ?? []) {
        if (!inRange(r.createdAt)) continue;
        for (const e of r.transactions ?? []) {
          const v = Math.abs(Number(e?.amountSet?.shopMoney?.amount ?? 0));
          if (v > 0) {
            amt += v;
            cnt += 1;
          }
        }
      }
      if (amt > 0) {
        const k = GAS_UNKNOWN_GATEWAY;
        ensurePayBucket(pay, k);
        pay[k].refund += amt;
        pay[k].refundTx += Math.max(1, cnt);
        orderRefundToday += amt;
        refundOrderSet.add(o.id);
      }
    }

    const isCancelled = Boolean(o.cancelledAt);

    // GAS observeVoucherChangeFromFace（キャンセル済み注文はノート観測しない）
    let orderVoucherFaceChange = 0;
    if (!isCancelled) {
      const face = parseVoucherFaceFromNote(o.note);
      if (face > 0) {
        const giftAppliedToday =
          Number(gwSaleMapToday["商品券釣有り"] || 0) +
          Number(gwSaleMapToday["商品券釣無し"] || 0) +
          Number(gwSaleMapToday["商品券"] || 0);
        const netToday = effectiveOrderSaleToday - orderRefundToday;
        if (netToday > 0) {
          orderVoucherFaceChange = Math.max(0, face - giftAppliedToday);
        }
      }
    }
    // cashChange と faceChange はどちらか大きい方を1回だけ計上（GAS と同式）
    if ((hasVoucherInNote || hasVoucherInGateway) && (orderVoucherCashChange > 0 || orderVoucherFaceChange > 0)) {
      voucherChangeObserved += Math.max(orderVoucherCashChange, orderVoucherFaceChange);
    }

    if (countRefundsForThisLocation) {
      refundsGross += orderRefundToday;
    }

    if (effectiveOrderSaleToday - (countRefundsForThisLocation ? orderRefundToday : 0) > 0) {
      saleOrderSet.add(o.id);
    }

    if (effectiveOrderSaleToday > 0) {
      const nodes = o.lineItems?.nodes ?? [];
      itemCount += nodes.reduce((s, n) => s + Number(n.quantity ?? 0), 0);
    }
    if (countRefundsForThisLocation && orderRefundToday > 0) {
      for (const r of o.refunds ?? []) {
        if (!inRange(r.createdAt)) continue;
        for (const ri of r.refundLineItems ?? []) {
          itemCount -= Number(ri.quantity ?? 0);
        }
      }
      refundOrderSet.add(o.id);
    }

    let orderDiscount = 0;
    let orderVip = 0;
    for (const li of o.lineItems?.nodes ?? []) {
      for (const da of li.discountAllocations ?? []) {
        const alloc = Number(da.allocatedAmountSet?.shopMoney?.amount ?? 0);
        const typ = da.discountApplication?.__typename ?? "";
        const code =
          typ === "DiscountCodeApplication" ? String(da.discountApplication?.code ?? "") : "";
        if (code && code.toUpperCase().startsWith("VIP-")) {
          orderVip += alloc;
        } else {
          orderDiscount += alloc;
        }
      }
    }

    let keepRatioToday = 0;
    if (effectiveOrderSaleToday > 0) {
      keepRatioToday = Math.max(0, effectiveOrderSaleToday - orderRefundToday) / effectiveOrderSaleToday;
    }
    discountsTotal += orderDiscount * keepRatioToday;
    vipPointsUsed += orderVip * keepRatioToday;

    const oTax = Number(
      o.currentTotalTaxSet?.shopMoney?.amount ?? o.totalTaxSet?.shopMoney?.amount ?? 0,
    );
    taxTotalShopify += oTax * keepRatioToday;
  }

  return {
    pay,
    refundsGross,
    discountsTotal: Math.round(discountsTotal),
    vipPointsUsed: Math.round(vipPointsUsed),
    saleOrderSet,
    refundOrderSet,
    itemCount,
    taxTotalShopify: Math.round(taxTotalShopify),
    voucherChangeObserved: Math.round(voucherChangeObserved),
    refundAttributionMismatchCount,
  };
}

export function totalFromPayBuckets(pay: Record<string, GasPayBucket>): number {
  let sum = 0;
  for (const p of Object.values(pay)) {
    sum += Math.round((p.sale || 0) - (p.refund || 0));
  }
  return Math.round(sum);
}
