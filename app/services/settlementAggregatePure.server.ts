/**
 * 精算集計の純関数（DB / Shopify 非依存）。
 * Phase 1 ユニットテスト用に settlementEngine から切り出し。挙動は元実装と同一。
 */
import {
  getPosLocationFromRefundTransactions,
  locationGidMatches,
  normalizeLocationGid,
  resolveRefundAggregationLocationGid,
  type RefundAggregationLocationMode,
  type RefundAggregationContext,
} from "./refundAggregationPure.server";
import {
  DEFAULT_POINT_REDEMPTION_RULES,
  isPointRedemption,
  type PointRedemptionRules,
} from "../utils/pointRedemptionRules";
import {
  remapRefundLabel,
  skuKey,
  type RefundRemapRule,
} from "../utils/settlementCalcSettings";

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
  /** 「売上を数える日」を注文の日にするときに使う */
  processedAt?: string | null;
  lineItems?: {
    nodes: {
      quantity: number;
      /** 点数に数えない SKU の判定に使う */
      sku?: string | null;
      originalUnitPriceSet?: { shopMoney: { amount: string } } | null;
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
    /** SUCCESS / FAILURE / ERROR / PENDING など。「注文の日」でオーソリを売上に数えるかの判定に使う */
    status?: string | null;
    /** VOID がどのオーソリを取り消したか */
    parentTransaction?: { id: string } | null;
    amountSet?: { shopMoney: { amount: string; currencyCode?: string } };
    gateway?: string;
    formattedGateway?: string | null;
    location?: { id: string } | null;
  }>;
  refunds?: Array<{
    createdAt?: string;
    refundLineItems?: {
      quantity: number;
      lineItem?: { sku?: string | null; originalUnitPriceSet?: { shopMoney: { amount: string } } | null } | null;
    }[];
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

/**
 * 注文の販売店舗とは別の店舗で当日返金された注文を、返金だけの集計入力へ変換する。
 * 売上 TX を除外することで、元店舗の当日売上を返金店舗へ移さない。
 */
export function buildCrossLocationRefundOnlyOrder(
  order: GasStyleOrder,
  inRange: (iso?: string) => boolean,
  settlementLocationId: string,
  locIdRaw: string,
  attributionMode: RefundAggregationLocationMode,
): GasStyleOrder | null {
  // 注文基準では、別店舗で処理した返金も販売店舗へ帰属させる。
  // 返金店舗向けの入力を追加すると同じ返金が両店舗へ二重計上されるため、
  // この補助入力は返金トランザクション基準のときだけ生成する。
  if (attributionMode !== "refund_transaction_pos_location") return null;

  const matchingTopLevelRefundTxIds = new Set(
    (order.transactions ?? [])
      .filter(
        (tx) =>
          String(tx.kind ?? "").toUpperCase() === "REFUND" &&
          inRange(tx.createdAt) &&
          locationGidMatches(tx.location?.id, settlementLocationId, locIdRaw),
      )
      .map((tx) => tx.id),
  );
  const matchingRefundTxIds = new Set<string>(matchingTopLevelRefundTxIds);
  const refunds = (order.refunds ?? []).flatMap((refund) => {
    if (!inRange(refund.createdAt)) return [];
    const matchingTransactions = (refund.transactions ?? []).filter(
      (tx) =>
        matchingTopLevelRefundTxIds.has(tx.id) ||
        locationGidMatches(tx.location?.id, settlementLocationId, locIdRaw),
    );
    for (const tx of matchingTransactions) {
      if (tx.id) matchingRefundTxIds.add(tx.id);
    }
    if (matchingTransactions.length === 0) return [];
    return [{ ...refund, transactions: matchingTransactions }];
  });

  const transactions = (order.transactions ?? []).filter((tx) => {
    if (String(tx.kind ?? "").toUpperCase() !== "REFUND") return false;
    if (matchingRefundTxIds.has(tx.id)) return true;
    return (
      inRange(tx.createdAt) &&
      locationGidMatches(tx.location?.id, settlementLocationId, locIdRaw)
    );
  });

  if (refunds.length === 0 && transactions.length === 0) return null;
  return {
    ...order,
    transactions,
    refunds,
    // 注文単位の最新値ではなく、上で残した返金 TX の店舗を正本にする。
    refundAggregationLocationGid: settlementLocationId,
  };
}

/**
 * 店舗の注文取得（location_id:X）の結果に、返金基準のときだけ「別店舗で売った注文の、X での返金」を足す。
 *
 * すでに店舗の取得に入っている注文は、retailLocation がどこであっても足さない。
 * 後から足した返金だけの入力が同じ id の元の注文（売上を持つ）を上書きすると、
 * その日の売上が消えるため（例: オンライン注文を X から出荷し、同じ日に X で返金）。
 * 元の注文は返金基準のとき返金 TX ごとに店舗を判定して数えるので、それで足りる。
 */
export function mergeCrossLocationRefundOrders<T extends GasStyleOrder>(
  storeOrders: T[],
  refundCandidates: T[],
  inRange: (iso?: string) => boolean,
  settlementLocationId: string,
  locIdRaw: string,
  attributionMode: RefundAggregationLocationMode,
): T[] {
  const existingOrderIds = new Set(storeOrders.map((order) => order.id));
  const byId = new Map<string, T>();
  for (const order of storeOrders) byId.set(order.id, order);
  for (const order of refundCandidates) {
    if (existingOrderIds.has(order.id) || byId.has(order.id)) continue;
    const refundOnly = buildCrossLocationRefundOnlyOrder(
      order,
      inRange,
      settlementLocationId,
      locIdRaw,
      attributionMode,
    );
    if (refundOnly) byId.set(order.id, refundOnly as T);
  }
  return [...byId.values()];
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
  /** 実際に使った計上 GID（返金基準: 当日返金 TX → metafield → resolve／注文基準: resolve） */
  usedGid: string | null;
  resolvedGid: string | null;
  metafieldGid: string | null;
};

/**
 * 返金計上ロケ:
 * - refund_transaction_pos_location（返金基準）では当日範囲の返金 TX を最優先
 *   当日 TX で解決できない管理画面・外部返金は metafield、最後に resolve
 *   後日の別店舗部分返品で、過去日の確定帰属を単一 metafield が上書きしない。
 * - order_transaction（注文基準・既定）では resolve（注文の店）だけを使う。metafield は不一致のログだけに使う。
 *   別の店で登録した特殊返金が metafield を書き換えても、通常の返品の計上先は変わらない（監査 P1-2）。
 *   精算は注文の店の注文しか取りに行かないので、metafield の店へ移すとどの店にも載らなくなる。
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
  const inRangeRefundPosGid =
    opts.attributionCtx.mode === "refund_transaction_pos_location"
      ? getPosLocationFromRefundTransactions(order, inRange)
      : null;
  const mismatch = !!(metafieldGid && resolvedGid && metafieldGid !== resolvedGid);
  const usedGid =
    opts.attributionCtx.mode === "refund_transaction_pos_location"
      ? inRangeRefundPosGid ?? metafieldGid ?? resolvedGid
      : resolvedGid;
  return {
    counts: locationGidMatches(usedGid, opts.settlementLocationId, opts.locIdRaw),
    mismatch,
    usedGid,
    resolvedGid,
    metafieldGid,
  };
}

/**
 * 精算の数え方の設定のうち、注文ごとの集計で使うもの（app/utils/settlementCalcSettings.ts）。
 * 渡さなければ今の数え方（決済の時刻の日・付け替えなし・SKU で外さない）。
 */
export type GasAggregateCalcOpts = {
  saleDateBasis: "transaction" | "order";
  /** skuKey でそろえた SKU */
  itemCountExcludedSkuKeys: ReadonlySet<string>;
  refundRemapRules: readonly RefundRemapRule[];
  /** 返金の付け替えの店の判定に使う、精算の店の数字の ID */
  locIdRaw: string;
};

export const DEFAULT_GAS_AGGREGATE_CALC_OPTS: GasAggregateCalcOpts = {
  saleDateBasis: "transaction",
  itemCountExcludedSkuKeys: new Set(),
  refundRemapRules: [],
  locIdRaw: "",
};

/** 点数に数えない明細か（印の付いた SKU の 0 円の明細だけ。値段を付けて売った明細は数える） */
export function isItemCountExcludedLine(
  line: { sku?: string | null; originalUnitPriceSet?: { shopMoney: { amount: string } } | null } | null | undefined,
  excluded: ReadonlySet<string>,
): boolean {
  if (!line || excluded.size === 0) return false;
  const key = skuKey(line.sku ?? "");
  if (!key || !excluded.has(key)) return false;
  return Number(line.originalUnitPriceSet?.shopMoney?.amount ?? 0) === 0;
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
  /** ポイント利用額に数える割引（保存した「ポイント/会員施策設定」。無ければ初めの値） */
  pointRules: PointRedemptionRules = DEFAULT_POINT_REDEMPTION_RULES,
  /** 精算の数え方の設定（売上を数える日・返金の付け替え・点数に数えない SKU） */
  calcOpts: GasAggregateCalcOpts = DEFAULT_GAS_AGGREGATE_CALC_OPTS,
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
    const refundTxCountsById = new Map<string, boolean>();
    const countedRefunds = new Set<NonNullable<GasStyleOrder["refunds"]>[number]>();
    for (const r of o.refunds ?? []) {
      if (!inRange(r.createdAt)) continue;
      const refundTransactions = r.transactions ?? [];
      const locatedTransactions = refundTransactions.filter((tx) => tx.location?.id);
      const splitByRefundTransaction =
        attributionOpts?.attributionCtx.mode === "refund_transaction_pos_location" &&
        locatedTransactions.length > 0;
      let refundCountsForLocation = countRefundsForThisLocation;
      if (splitByRefundTransaction) {
        refundCountsForLocation = locatedTransactions.some((tx) =>
          locationGidMatches(
            tx.location?.id,
            attributionOpts!.settlementLocationId,
            attributionOpts!.locIdRaw,
          ),
        );
      }
      if (refundCountsForLocation) countedRefunds.add(r);

      for (const e of refundTransactions) {
        if (!e?.id) continue;
        refundTxIdsInDay.add(e.id);
        const txCountsForLocation =
          splitByRefundTransaction && e.location?.id
            ? locationGidMatches(
                e.location.id,
                attributionOpts!.settlementLocationId,
                attributionOpts!.locIdRaw,
              )
            : refundCountsForLocation;
        refundTxCountsById.set(e.id, txCountsForLocation);
      }
    }

    const txs = o.transactions ?? [];
    // 「売上を数える日」が注文の日のとき: 売上の決済は注文の日（processedAt）で決める。
    // 売上の決済（SALE / CAPTURE）がまだ無い注文は、オーソリを売上に数える（ciara-system と同じ）。
    const byOrderDate = calcOpts.saleDateBasis === "order";
    const hasSettledSaleTx = txs.some((tx) => isSettledSaleKind(tx.kind));
    const orderOnThisDay = byOrderDate && inRange(o.processedAt ?? undefined);
    // オーソリを売上に数えるのは、成功していて、取り消し（VOID）されていないものだけ。
    // 失敗・期限切れ・VOID のオーソリは売上にも件数にも入れない。
    const voidedAuthIds = new Set<string>();
    let voidWithoutParent = false;
    for (const tx of txs) {
      if (normalizeTxKind(tx.kind) !== "VOID" || !isSuccessStatus(tx.status)) continue;
      const parentId = tx.parentTransaction?.id;
      if (parentId) voidedAuthIds.add(parentId);
      else voidWithoutParent = true;
    }
    const isCountableAuthorization = (tx: (typeof txs)[number]) =>
      normalizeTxKind(tx.kind) === "AUTHORIZATION" &&
      isSuccessStatus(tx.status) &&
      !voidWithoutParent &&
      !voidedAuthIds.has(tx.id);
    const countsAsSaleTx = (tx: (typeof txs)[number]) =>
      isSettledSaleKind(tx.kind) || (byOrderDate && !hasSettledSaleTx && isCountableAuthorization(tx));
    const todaysTx = txs.filter((tx) => {
      if (byOrderDate && countsAsSaleTx(tx)) return orderOnThisDay;
      const byTime = inRange(tx.createdAt);
      const byRefundLink = refundTxIdsInDay.has(tx.id);
      return byTime || (String(tx.kind) === "REFUND" && byRefundLink);
    });

    let orderRefundToday = 0;
    const gwSaleMapToday: Record<string, number> = {};

    for (const tx of todaysTx) {
      const amt = Number(tx.amountSet?.shopMoney?.amount ?? 0);
      const kind = String(tx.kind ?? "");
      const baseGw = gasTxLabel(tx);
      const gw =
        kind === "REFUND"
          ? remapRefundLabel(baseGw, tx, calcOpts.refundRemapRules, calcOpts.locIdRaw)
          : baseGw;
      ensurePayBucket(pay, gw);

      if (kind === "SALE" || kind === "CAPTURE" || (byOrderDate && countsAsSaleTx(tx))) {
        gwSaleMapToday[gw] = (gwSaleMapToday[gw] || 0) + amt;
        pay[gw].saleTx += 1;
      } else if (kind === "REFUND") {
        const txCountsForLocation =
          refundTxCountsById.get(tx.id) ?? countRefundsForThisLocation;
        if (!txCountsForLocation) continue;
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
    if (hasRefundObjToday && !hasRefundTxToday) {
      let amt = 0;
      let cnt = 0;
      for (const r of o.refunds ?? []) {
        if (!inRange(r.createdAt)) continue;
        if (!countedRefunds.has(r)) continue;
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

    refundsGross += orderRefundToday;

    if (effectiveOrderSaleToday - orderRefundToday > 0) {
      saleOrderSet.add(o.id);
    }

    if (effectiveOrderSaleToday > 0) {
      const nodes = o.lineItems?.nodes ?? [];
      itemCount += nodes.reduce(
        (s, n) =>
          isItemCountExcludedLine(n, calcOpts.itemCountExcludedSkuKeys) ? s : s + Number(n.quantity ?? 0),
        0,
      );
    }
    if (orderRefundToday > 0) {
      for (const r of o.refunds ?? []) {
        if (!inRange(r.createdAt)) continue;
        if (!countedRefunds.has(r)) continue;
        for (const ri of r.refundLineItems ?? []) {
          if (isItemCountExcludedLine(ri.lineItem, calcOpts.itemCountExcludedSkuKeys)) continue;
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
        // POS の Shop Point は手動割引（タイトル "Shop Point"）として入る。自動割引は同名でも数えない。
        const title =
          typ === "ManualDiscountApplication" || typ === "ScriptDiscountApplication"
            ? String(da.discountApplication?.title ?? "")
            : "";
        if (isPointRedemption(code, title, pointRules)) {
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

function normalizeTxKind(kind: string | null | undefined): string {
  return String(kind ?? "").trim().toUpperCase();
}

/** 決済が成功したか（status が無いときは成功と見なさない） */
function isSuccessStatus(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toUpperCase() === "SUCCESS";
}

/** 確定した売上の決済（SALE / CAPTURE） */
function isSettledSaleKind(kind: string | null | undefined): boolean {
  const k = normalizeTxKind(kind);
  return k === "SALE" || k === "CAPTURE";
}

export function totalFromPayBuckets(pay: Record<string, GasPayBucket>): number {
  let sum = 0;
  for (const p of Object.values(pay)) {
    sum += Math.round((p.sale || 0) - (p.refund || 0));
  }
  return Math.round(sum);
}

/**
 * ポイント利用として集計する割引か。見分け方の正本は `app/utils/pointRedemptionRules.ts`（設定で変えられる）。
 * 既存の呼び出しとテストのためにここからも export する。
 */
export { isPointRedemption };
