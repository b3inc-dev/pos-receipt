/**
 * 精算集計の純関数（DB / Shopify 非依存）。
 * Phase 1 ユニットテスト用に settlementEngine から切り出し。挙動は元実装と同一。
 */
import {
  DEFAULT_VOUCHER_DETECTION_RULES,
  escapeRegExp,
  parseVoucherFaceFromNoteWithRules,
  voucherAppliedGatewayNames,
  type VoucherDetectionRules,
} from "./voucherChangePure.server";
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
import {
  lineChargedAmount,
  lineTaxAmount,
  nonSalesFeeLineIds,
  refundLineChargedAmount,
  type FeeLineItemLike,
  type FeeRefundLineItemLike,
} from "./nonSalesFeeLines";

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
  /** 税込価格の店か（売上に含めない手数料の明細の金額計算に使う。無ければ税込とみなす） */
  taxesIncluded?: boolean | null;
  lineItems?: {
    nodes: (Omit<FeeLineItemLike, "quantity" | "discountAllocations"> & {
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
    })[];
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
    refundLineItems?: (Omit<FeeRefundLineItemLike, "quantity" | "lineItem"> & {
      quantity: number;
      lineItem?: {
        id?: string | null;
        sku?: string | null;
        originalUnitPriceSet?: { shopMoney: { amount: string } } | null;
      } | null;
    })[];
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
/** 決まった分け方の商品券のキー（おつりの観測で足す順） */
const GAS_VOUCHER_KEYS_ORDER: readonly string[] = ["商品券釣有り", "商品券釣無し", "商品券"];

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

/**
 * 支払方法の集計キーの種類。精算の中で意味を持つものだけ分ける。
 * - cash: 現金（注文ごとの現金の上限 = GAS cash cap の対象）
 * - voucher: 商品券（ノートの額面と商品券の充当からおつりを見る対象）
 * - other: それ以外
 */
export type PaymentKeyKind = "cash" | "voucher" | "other";

export type PaymentKeyInfo = {
  /** 精算の支払方法の行の名前（pay バケットのキー・payment section の gateway） */
  key: string;
  kind: PaymentKeyKind;
};

/** 取引の gateway / formattedGateway から集計キーを決める */
export type PaymentKeyResolver = (
  gateway: string,
  formattedGateway?: string | null,
) => PaymentKeyInfo;

/** 決まった分け方（gasNormalizeGatewayLabel）のキーの種類。今の精算と同じ判定 */
export function builtinPaymentKeyKind(key: string): PaymentKeyKind {
  if (key === GAS_GATEWAY_CASH) return "cash";
  if (/商品券/.test(key)) return "voucher";
  return "other";
}

/** 決まった分け方（今の動き・初めの値） */
export const builtinPaymentKeyResolver: PaymentKeyResolver = (gateway, formattedGateway) => {
  const key = gasNormalizeGatewayLabel(gateway ?? "", formattedGateway);
  return { key, kind: builtinPaymentKeyKind(key) };
};

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
  /**
   * 支払方法の集計キーの決め方。渡さなければ決まった分け方（builtinPaymentKeyResolver・今の動き）。
   * 「精算の数え方」で「支払方法マスタで分ける」を選んだ店は paymentKeyMasterPure の resolver を渡す。
   */
  paymentKey?: PaymentKeyResolver;
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
  /** 商品券のお釣りの自動判定（保存した「商品券設定」。無ければ初めの値＝GAS と同じ） */
  voucherRules: VoucherDetectionRules = DEFAULT_VOUCHER_DETECTION_RULES,
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
  /** voucherChangeObserved の注文ごとの内訳（キーは注文 ID）。手入力との二重計上を防ぐのに使う */
  voucherChangeByOrder: Record<string, number>;
  /**
   * 現金の預かりが会計に必要な額より多かった分（注文ごと）。支払方法別の現金からはもう引いてある。
   * 納金金額から商品券の釣銭を引くとき、この分を二重に引かないために使う。
   */
  voucherCashCapByOrder: Record<string, number>;
  /**
   * 売上に含めない手数料の明細（`_lsi_fee="1"` かつ `_lsi_fee_sales="0"`）の当日分（売った分 − 計上対象の返金分）。
   * 支払方法別の金額（pay）には入ったまま。総売上はここを引く（settlementEngine）。
   */
  nonSalesFeeTotal: number;
} {
  const pay: Record<string, GasPayBucket> = {};
  const resolvePaymentKey = calcOpts.paymentKey ?? builtinPaymentKeyResolver;
  let refundsGross = 0;
  let discountsTotal = 0;
  let vipPointsUsed = 0;
  const saleOrderSet = new Set<string>();
  const refundOrderSet = new Set<string>();
  let itemCount = 0;
  let taxTotalShopify = 0;
  let voucherChangeObserved = 0;
  let refundAttributionMismatchCount = 0;
  const voucherChangeByOrder: Record<string, number> = {};
  const voucherCashCapByOrder: Record<string, number> = {};
  let nonSalesFeeTotal = 0;
  const voucherKeywordRe = new RegExp(escapeRegExp(voucherRules.keyword));
  const voucherGatewayNames = voucherAppliedGatewayNames(voucherRules.keyword);

  for (const o of orders) {
    const feeLineIds = nonSalesFeeLineIds(o.lineItems?.nodes);
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
    /** この注文の売上の行のうち、現金・商品券として扱うキー */
    const cashSaleKeys = new Set<string>();
    const voucherSaleKeys = new Set<string>();

    for (const tx of todaysTx) {
      const amt = Number(tx.amountSet?.shopMoney?.amount ?? 0);
      const kind = String(tx.kind ?? "");
      const keyInfo = resolvePaymentKey(tx.gateway ?? "", tx.formattedGateway);
      const baseGw = keyInfo.key;
      const gw =
        kind === "REFUND"
          ? remapRefundLabel(baseGw, tx, calcOpts.refundRemapRules, calcOpts.locIdRaw)
          : baseGw;
      ensurePayBucket(pay, gw);

      if (kind === "SALE" || kind === "CAPTURE" || (byOrderDate && countsAsSaleTx(tx))) {
        gwSaleMapToday[gw] = (gwSaleMapToday[gw] || 0) + amt;
        if (keyInfo.kind === "cash") cashSaleKeys.add(gw);
        else if (keyInfo.kind === "voucher") voucherSaleKeys.add(gw);
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
    // 現金の行は決まった分け方では「現金」1 つ。マスタで分ける店は現金の種類のマスタがいくつあってもよい
    const cashEntries = Object.entries(gwSaleMapToday).filter(([k]) => cashSaleKeys.has(k));
    const rawCashSale = cashEntries.reduce((acc, [, v]) => acc + Number(v || 0), 0);
    const nonCashSaleTotal = Object.entries(gwSaleMapToday)
      .filter(([k]) => !cashSaleKeys.has(k))
      .reduce((acc, [, v]) => acc + Number(v || 0), 0);
    const orderFinal = Number(o.totalPriceSet?.shopMoney?.amount ?? 0);
    let effectiveCashSale = rawCashSale;
    let orderVoucherCashChange = 0;
    if (rawCashSale > 0) {
      const neededCashForOrder = Math.max(0, orderFinal - nonCashSaleTotal);
      effectiveCashSale = Math.min(rawCashSale, neededCashForOrder);
      orderVoucherCashChange = Math.max(0, rawCashSale - effectiveCashSale);
      if (orderVoucherCashChange > 0) {
        voucherCashCapByOrder[o.id] = (voucherCashCapByOrder[o.id] ?? 0) + orderVoucherCashChange;
      }
    }
    const hasVoucherInNote = voucherKeywordRe.test(o.note ?? "");
    // 商品券の行: 支払方法の分け方で「商品券」になったキー（#82）か、商品券設定の言葉を含むキー（#92）
    const hasVoucherInGateway = Object.keys(gwSaleMapToday).some(
      (k) => voucherSaleKeys.has(k) || voucherKeywordRe.test(k),
    );
    // 現金の上限で削る額。現金の行が 2 つ以上なら、並んだ順に削る（1 つなら今と同じ式）
    let cashCut = cashEntries.length > 1 ? rawCashSale - effectiveCashSale : 0;
    for (const [gw, amt] of Object.entries(gwSaleMapToday)) {
      ensurePayBucket(pay, gw);
      if (!cashSaleKeys.has(gw)) {
        pay[gw].sale += Number(amt);
      } else if (cashEntries.length === 1) {
        pay[gw].sale += effectiveCashSale;
      } else {
        const v = Number(amt || 0);
        const cut = Math.min(v, Math.max(0, cashCut));
        cashCut -= cut;
        pay[gw].sale += v - cut;
      }
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
      const face = parseVoucherFaceFromNoteWithRules(o.note, voucherRules);
      if (face > 0) {
        // 足す順は商品券設定の名前（釣有り・釣無し・言葉そのもの）を先に、そのあと分け方で商品券になったキー
        const voucherKeysInOrder = [
          ...voucherGatewayNames,
          ...[...voucherSaleKeys].filter((k) => !voucherGatewayNames.includes(k)),
        ];
        const giftAppliedToday = voucherKeysInOrder.reduce(
          (acc, k) => acc + Number(gwSaleMapToday[k] || 0),
          0,
        );
        const netToday = effectiveOrderSaleToday - orderRefundToday;
        if (netToday > 0) {
          orderVoucherFaceChange = Math.max(0, face - giftAppliedToday);
        }
      }
    }
    // cashChange と faceChange はどちらか大きい方を1回だけ計上（GAS と同式）
    if (
      voucherRules.autoDetectionEnabled &&
      (hasVoucherInNote || hasVoucherInGateway) &&
      (orderVoucherCashChange > 0 || orderVoucherFaceChange > 0)
    ) {
      const change = Math.max(orderVoucherCashChange, orderVoucherFaceChange);
      voucherChangeObserved += change;
      voucherChangeByOrder[o.id] = (voucherChangeByOrder[o.id] ?? 0) + change;
    }

    refundsGross += orderRefundToday;

    if (effectiveOrderSaleToday - orderRefundToday > 0) {
      saleOrderSet.add(o.id);
    }

    // 売上に含めない手数料の明細は点数・割引・税・総売上から外す（支払方法別の金額はそのまま）
    let orderFeeSoldToday = 0;
    let orderFeeTaxSoldToday = 0;
    if (effectiveOrderSaleToday > 0) {
      const nodes = o.lineItems?.nodes ?? [];
      itemCount += nodes.reduce(
        (s, n) =>
          (n.id && feeLineIds.has(String(n.id))) || isItemCountExcludedLine(n, calcOpts.itemCountExcludedSkuKeys)
            ? s
            : s + Number(n.quantity ?? 0),
        0,
      );
      if (feeLineIds.size > 0) {
        // 分けて払った注文（複数日）でも二重に引かないよう、当日の支払の割合で按分する
        const paidShare = orderFinal > 0 ? Math.min(1, effectiveOrderSaleToday / orderFinal) : 1;
        for (const n of nodes) {
          if (!n.id || !feeLineIds.has(String(n.id))) continue;
          orderFeeSoldToday += lineChargedAmount(n, o.taxesIncluded) * paidShare;
          orderFeeTaxSoldToday += lineTaxAmount(n) * paidShare;
        }
      }
    }
    let orderFeeRefundedToday = 0;
    if (orderRefundToday > 0) {
      for (const r of o.refunds ?? []) {
        if (!inRange(r.createdAt)) continue;
        if (!countedRefunds.has(r)) continue;
        for (const ri of r.refundLineItems ?? []) {
          if (ri.lineItem?.id && feeLineIds.has(String(ri.lineItem.id))) {
            orderFeeRefundedToday += refundLineChargedAmount(ri, o.taxesIncluded);
            continue;
          }
          if (isItemCountExcludedLine(ri.lineItem, calcOpts.itemCountExcludedSkuKeys)) continue;
          itemCount -= Number(ri.quantity ?? 0);
        }
      }
      refundOrderSet.add(o.id);
    }
    nonSalesFeeTotal += orderFeeSoldToday - orderFeeRefundedToday;

    let orderDiscount = 0;
    let orderVip = 0;
    for (const li of o.lineItems?.nodes ?? []) {
      if (li.id && feeLineIds.has(String(li.id))) continue;
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
    taxTotalShopify += oTax * keepRatioToday - orderFeeTaxSoldToday * keepRatioToday;
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
    voucherChangeByOrder,
    voucherCashCapByOrder,
    nonSalesFeeTotal: Math.round(nonSalesFeeTotal),
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
