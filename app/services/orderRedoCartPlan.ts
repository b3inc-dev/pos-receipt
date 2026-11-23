/**
 * 会計やり直し（POS のカートに入れる）の中身を、元の注文から組み立てる。
 *
 * POS の Cart API（shopify.cart）では、バリアントの単価そのものは書き換えられない。
 * そのため「元の注文で払う予定だった額」に合わせるために、
 * 今のバリアントの値段との差と元の割引を、商品ごとの割引（1個あたりの定額）で入れる。
 * 1個あたりで割り切れない端数は、カート全体の定額割引にまとめる。
 *
 * ここは DB や Shopify を呼ばない純粋な処理（試験しやすくするため）。
 */

export type OrderRedoMethod = "both" | "cart" | "draft";

export const ORDER_REDO_METHODS: readonly OrderRedoMethod[] = ["both", "cart", "draft"];

export function normalizeOrderRedoMethod(v: unknown): OrderRedoMethod {
  return v === "cart" || v === "draft" ? v : "both";
}

/** 設定と注文の状態から、POS に出す「会計をやり直す」の手段を決める */
export function resolveOrderRedoOptions(
  settings: { enableOrderRedoDraft?: boolean; orderRedoMethod?: unknown },
  eligible: boolean,
): { canRedoToCart: boolean; canRedoAsDraft: boolean } {
  if (!settings.enableOrderRedoDraft || !eligible) {
    return { canRedoToCart: false, canRedoAsDraft: false };
  }
  const method = normalizeOrderRedoMethod(settings.orderRedoMethod);
  return {
    canRedoToCart: method === "both" || method === "cart",
    canRedoAsDraft: method === "both" || method === "draft",
  };
}

/** 小数を持たない通貨（Shopify の金額文字列も整数で来る） */
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "PYG"]);

export function currencyDecimals(currencyCode: string | null | undefined): number {
  return ZERO_DECIMAL_CURRENCIES.has(String(currencyCode ?? "").toUpperCase()) ? 0 : 2;
}

function toMinor(amount: unknown, decimals: number): number {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10 ** decimals);
}

function fromMinor(minor: number, decimals: number): string {
  return (minor / 10 ** decimals).toFixed(decimals);
}

/** gid://shopify/ProductVariant/123 → 123 */
export function numericIdFromGid(gid: unknown): number | null {
  const m = String(gid ?? "").match(/(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

type MoneyBag = { shopMoney?: { amount?: string | null; currencyCode?: string | null } | null } | null;

export type RedoCartSourceLine = {
  title?: string | null;
  name?: string | null;
  quantity?: number | null;
  taxable?: boolean | null;
  variant?: { id?: string | null; price?: string | null } | null;
  originalUnitPriceSet?: MoneyBag;
  discountAllocations?: {
    allocatedAmountSet?: MoneyBag;
    discountApplication?: { title?: string | null; code?: string | null } | null;
  }[] | null;
};

export type RedoCartSourceOrder = {
  name?: string | null;
  currencyCode?: string | null;
  customer?: { id?: string | null } | null;
  lineItems?: { nodes?: RedoCartSourceLine[] | null } | null;
};

export type RedoCartLineDiscount = { title: string; amount: string };

export type RedoCartLine =
  | {
      kind: "variant";
      variantId: number;
      quantity: number;
      title: string;
      /** 1個あたりの定額割引。無ければ null */
      unitDiscount: RedoCartLineDiscount | null;
    }
  | {
      kind: "custom";
      title: string;
      /** 1個あたりの値段（元の注文の単価） */
      price: string;
      quantity: number;
      taxable: boolean;
      unitDiscount: RedoCartLineDiscount | null;
    };

export type RedoCartWarning =
  | { code: "deleted_product"; title: string }
  | { code: "price_lower_now"; title: string; difference: string };

export type RedoCartPlan = {
  orderName: string;
  currencyCode: string;
  /** 数字の顧客 ID（Cart API の setCustomer 用）。顧客なしは null */
  customerId: number | null;
  lines: RedoCartLine[];
  /** 端数をまとめたカート全体の定額割引。無ければ null */
  cartDiscount: RedoCartLineDiscount | null;
  /** カートに入れたあとの見込みの合計（割引後・税は POS の計算） */
  expectedTotal: string;
  warnings: RedoCartWarning[];
  skippedLineCount: number;
};

export const REDO_DISCOUNT_TITLE = "元の注文の割引";
export const REDO_REMAINDER_TITLE = "元の注文の割引（端数）";

type Bucket = {
  kind: "variant" | "custom";
  variantId: number | null;
  title: string;
  quantity: number;
  /** カートに入る 1 個の値段（バリアントは今の値段、カスタムは元の単価） */
  cartUnitMinor: number;
  /** 元の注文で払う予定だった額（割引後）の合計 */
  targetMinor: number;
  taxable: boolean;
  discountTitles: Set<string>;
  hasPriceDiff: boolean;
};

export function buildRedoCartPlan(order: RedoCartSourceOrder): RedoCartPlan {
  const lineNodes = order.lineItems?.nodes ?? [];
  const currencyCode =
    order.currencyCode ||
    lineNodes.find((l) => l.originalUnitPriceSet?.shopMoney?.currencyCode)?.originalUnitPriceSet?.shopMoney
      ?.currencyCode ||
    "JPY";
  const decimals = currencyDecimals(currencyCode);

  const buckets: Bucket[] = [];
  const byVariant = new Map<number, Bucket>();
  const warnings: RedoCartWarning[] = [];
  let skippedLineCount = 0;

  for (const li of lineNodes) {
    const qty = Math.max(0, Math.floor(Number(li.quantity ?? 0)));
    if (qty <= 0) {
      skippedLineCount += 1;
      continue;
    }
    const title = String(li.title ?? li.name ?? "").trim() || "商品";
    const origUnitMinor = toMinor(li.originalUnitPriceSet?.shopMoney?.amount, decimals);
    let discountMinor = 0;
    const titles = new Set<string>();
    for (const da of li.discountAllocations ?? []) {
      discountMinor += toMinor(da.allocatedAmountSet?.shopMoney?.amount, decimals);
      const t = String(da.discountApplication?.title ?? da.discountApplication?.code ?? "").trim();
      if (t) titles.add(t);
    }
    const targetMinor = Math.max(0, origUnitMinor * qty - discountMinor);
    const variantId = numericIdFromGid(li.variant?.id);
    const taxable = li.taxable !== false;

    if (variantId != null) {
      const hasCurrentPrice = li.variant?.price != null && li.variant?.price !== "";
      const cartUnitMinor = hasCurrentPrice ? toMinor(li.variant?.price, decimals) : origUnitMinor;
      const existing = byVariant.get(variantId);
      if (existing) {
        existing.quantity += qty;
        existing.targetMinor += targetMinor;
        titles.forEach((t) => existing.discountTitles.add(t));
        if (cartUnitMinor !== origUnitMinor) existing.hasPriceDiff = true;
        continue;
      }
      const b: Bucket = {
        kind: "variant",
        variantId,
        title,
        quantity: qty,
        cartUnitMinor,
        targetMinor,
        taxable,
        discountTitles: titles,
        hasPriceDiff: cartUnitMinor !== origUnitMinor,
      };
      byVariant.set(variantId, b);
      buckets.push(b);
      continue;
    }

    // 商品が削除された（バリアントが無い）行は、同じ名前・元の単価のカスタム商品で入れる
    warnings.push({ code: "deleted_product", title });
    buckets.push({
      kind: "custom",
      variantId: null,
      title,
      quantity: qty,
      cartUnitMinor: origUnitMinor,
      targetMinor,
      taxable,
      discountTitles: titles,
      hasPriceDiff: false,
    });
  }

  const lines: RedoCartLine[] = [];
  let remainderMinor = 0;
  let expectedMinor = 0;

  for (const b of buckets) {
    const fullMinor = b.cartUnitMinor * b.quantity;
    let neededMinor = fullMinor - b.targetMinor;
    if (neededMinor < 0) {
      // 今の値段のほうが安い。値段は上げられないので、そのまま入れて知らせる
      warnings.push({
        code: "price_lower_now",
        title: b.title,
        difference: fromMinor(-neededMinor, decimals),
      });
      neededMinor = 0;
    }
    const unitMinor = Math.floor(neededMinor / b.quantity);
    remainderMinor += neededMinor - unitMinor * b.quantity;
    expectedMinor += fullMinor - neededMinor;

    const discountTitle =
      !b.hasPriceDiff && b.discountTitles.size === 1 ? [...b.discountTitles][0] : REDO_DISCOUNT_TITLE;
    const unitDiscount =
      unitMinor > 0 ? { title: discountTitle.slice(0, 255), amount: fromMinor(unitMinor, decimals) } : null;

    if (b.kind === "variant" && b.variantId != null) {
      lines.push({ kind: "variant", variantId: b.variantId, quantity: b.quantity, title: b.title, unitDiscount });
    } else {
      lines.push({
        kind: "custom",
        title: b.title.slice(0, 255),
        price: fromMinor(b.cartUnitMinor, decimals),
        quantity: b.quantity,
        taxable: b.taxable,
        unitDiscount,
      });
    }
  }

  return {
    orderName: String(order.name ?? ""),
    currencyCode,
    customerId: numericIdFromGid(order.customer?.id),
    lines,
    cartDiscount:
      remainderMinor > 0 ? { title: REDO_REMAINDER_TITLE, amount: fromMinor(remainderMinor, decimals) } : null,
    expectedTotal: fromMinor(expectedMinor, decimals),
    warnings,
    skippedLineCount,
  };
}
