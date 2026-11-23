/**
 * 売上に含めない手数料の明細（例: Location Stock の POS Lite 配送の送料の行）。
 *
 * 見分け方は明細の属性（GraphQL `LineItem.customAttributes` / REST `line_items[].properties`）だけで行う。
 * 明細の名前（「送料」など）では見分けない（店ごとに名前を変えられるため）。
 *
 * - `_lsi_fee = "1"` かつ `_lsi_fee_sales = "0"` → 売上に含めない（この明細を精算・売上サマリーから外す）
 *   領収書は受け取った全額のまま（T 2026-11-23）
 * - `_lsi_fee = "1"` かつ `_lsi_fee_sales` が `"0"` 以外（`"1"`・無し） → 今までどおり売上に含める
 * - `_lsi_fee` が無い明細 → 普通の明細
 *
 * 値は会計のときの設定で、あとから設定を変えても前の注文は変わらない（Location Stock 側の仕様）。
 * DB / Shopify に依存しない純関数のみ。
 */

export const FEE_LINE_ATTR_KEY = "_lsi_fee";
export const FEE_LINE_SALES_ATTR_KEY = "_lsi_fee_sales";

export type FeeLineAttribute = { key?: string | null; value?: string | null };

type Money = { shopMoney?: { amount?: string | number | null } | null } | null | undefined;

/** 金額計算に使う明細の形（Shopify GraphQL LineItem の部分集合） */
export interface FeeLineItemLike {
  id?: string | null;
  quantity?: number | null;
  customAttributes?: FeeLineAttribute[] | null;
  originalTotalSet?: Money;
  discountAllocations?: { allocatedAmountSet?: Money }[] | null;
  taxLines?: { priceSet?: Money }[] | null;
}

/** 返金明細の形（Shopify GraphQL RefundLineItem の部分集合） */
export interface FeeRefundLineItemLike {
  quantity?: number | null;
  lineItem?: { id?: string | null } | null;
  subtotalSet?: Money;
  totalTaxSet?: Money;
}

function num(m: Money): number {
  const v = Number(m?.shopMoney?.amount ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function attrValue(attrs: FeeLineAttribute[] | null | undefined, key: string): string | null {
  for (const a of attrs ?? []) {
    if (a && String(a.key ?? "") === key) return String(a.value ?? "").trim();
  }
  return null;
}

/** 売上に含めない手数料の明細か（`_lsi_fee="1"` かつ `_lsi_fee_sales="0"`） */
export function isNonSalesFeeLine(line: { customAttributes?: FeeLineAttribute[] | null }): boolean {
  const attrs = line.customAttributes;
  return (
    attrValue(attrs, FEE_LINE_ATTR_KEY) === "1" && attrValue(attrs, FEE_LINE_SALES_ATTR_KEY) === "0"
  );
}

/** 明細の税額（taxLines の合計） */
export function lineTaxAmount(line: FeeLineItemLike): number {
  return (line.taxLines ?? []).reduce((s, t) => s + num(t?.priceSet), 0);
}

/** 明細の割引（discountAllocations の合計） */
export function lineDiscountAmount(line: FeeLineItemLike): number {
  return (line.discountAllocations ?? []).reduce((s, d) => s + num(d?.allocatedAmountSet), 0);
}

/**
 * お客さまがこの明細に払った金額（注文の totalPriceSet と同じ基準）。
 * 元の金額 − 割引。税抜価格の店（taxesIncluded=false）は税を足す。
 */
export function lineChargedAmount(line: FeeLineItemLike, taxesIncluded: boolean | null | undefined): number {
  const base = num(line.originalTotalSet) - lineDiscountAmount(line);
  const tax = taxesIncluded === false ? lineTaxAmount(line) : 0;
  return Math.max(0, base + tax);
}

/** 返金明細の金額（注文の totalPriceSet と同じ基準） */
export function refundLineChargedAmount(
  rli: FeeRefundLineItemLike,
  taxesIncluded: boolean | null | undefined,
): number {
  const base = num(rli.subtotalSet);
  const tax = taxesIncluded === false ? num(rli.totalTaxSet) : 0;
  return Math.max(0, base + tax);
}

/** 注文の中の「売上に含めない手数料の明細」の id（id が無い明細は数えない） */
export function nonSalesFeeLineIds(lines: FeeLineItemLike[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const li of lines ?? []) {
    if (li?.id && isNonSalesFeeLine(li)) ids.add(String(li.id));
  }
  return ids;
}

/**
 * 注文の「売上に含めない手数料の明細」の合計（金額・税・点数）。
 * 返金は見ない（会計のときの金額）。
 */
export function nonSalesFeeForOrder(order: {
  taxesIncluded?: boolean | null;
  lineItems?: { nodes?: FeeLineItemLike[] | null } | null;
}): { amount: number; tax: number; quantity: number } {
  let amount = 0;
  let tax = 0;
  let quantity = 0;
  for (const li of order.lineItems?.nodes ?? []) {
    if (!li || !isNonSalesFeeLine(li)) continue;
    amount += lineChargedAmount(li, order.taxesIncluded);
    tax += lineTaxAmount(li);
    quantity += Number(li.quantity ?? 0);
  }
  return { amount, tax, quantity };
}

/** GraphQL の LineItem に足すフィールド（精算の注文取得） */
export const FEE_LINE_ITEM_GRAPHQL_FIELDS = `
            id
            customAttributes { key value }
            originalTotalSet { shopMoney { amount } }
            taxLines { priceSet { shopMoney { amount } } }`;

/**
 * 保存済みの精算（Settlement 行）から「売上に含めない手数料」の金額を戻す。
 * 精算は「総売上 = 支払方法別の合計 − 売上に含めない手数料」で保存しているので、その差。
 * DB に列を足さずに印字で見せるため。総売上が 0 の日（0 で止めた日）は戻せないので 0。
 * この版より前に保存した精算は差が 0（丸めの ±1 は 0 とみなす）なので何も出ない。
 */
export function nonSalesFeeTotalFromSaved(
  total: number,
  paymentSections: { net?: number | string | null; refund?: number | string | null }[],
): number {
  if (!(Number(total) > 0)) return 0;
  const sections = paymentSections.reduce(
    (s, p) => s + Math.round(Number(p.net ?? 0) - Number(p.refund ?? 0)),
    0,
  );
  const diff = Math.round(sections - Number(total));
  // 保存前の総売上は丸める前の合計を丸めているので、前からの精算でも ±1 の差は出うる。それは送料とみなさない
  return Math.abs(diff) <= 1 ? 0 : diff;
}

