/**
 * 印字の道（販売・ギフト・精算／点検・領収書）の値を、レイアウトのテンプレートに渡す形（receiptLayoutData.ts）に変える
 *
 * ここは純粋な関数だけ（DB・Shopify は呼ばない）。呼ぶ側は receiptLayoutPrint.server.ts。
 * Ciara の liquid が印字のときにしていた整形（県名を日本語に・+81 を 0 に・スタッフ名を明細のプロパティから）もここでする。
 */
import { sampleTemplateData } from "./receiptLayoutData";
import type {
  KeyValue,
  LocationData,
  NamedAmount,
  OrderData,
  OrderLineItem,
  ReceiptData,
  ReceiptTemplateData,
  SettlementData,
  ShippingAddress,
  TaxLine,
} from "./receiptLayoutData";
import {
  orderSettlementPayments,
  settlementCashDeposit,
  type SettlementCalcSettings,
  type SettlementSectionInput,
} from "./receiptLayoutSettlementCalc";

// ── 住所・電話 ──────────────────────────────────────────

const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
  "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
  "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
  "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];
const PREFECTURE_ROMAJI = [
  "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima", "ibaraki", "tochigi", "gunma",
  "saitama", "chiba", "tokyo", "kanagawa", "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano",
  "gifu", "shizuoka", "aichi", "mie", "shiga", "kyoto", "osaka", "hyogo", "nara", "wakayama",
  "tottori", "shimane", "okayama", "hiroshima", "yamaguchi", "tokushima", "kagawa", "ehime", "kochi", "fukuoka",
  "saga", "nagasaki", "kumamoto", "oita", "miyazaki", "kagoshima", "okinawa",
];

/** JP-13・Tokyo・Tōkyō・東京都 → 東京都。分からなければそのまま */
export function japanesePrefecture(code: unknown, name?: unknown): string {
  const c = String(code ?? "").trim().toUpperCase();
  const m = /^(?:JP-)?(\d{1,2})$/.exec(c);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 47) return PREFECTURES[n - 1];
  }
  for (const raw of [name, code]) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    if (PREFECTURES.includes(s)) return s;
    const key = s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[\s-]+(ken|to|fu|prefecture)$/, "")
      .replace(/[^a-z]/g, "");
    const i = PREFECTURE_ROMAJI.indexOf(key);
    if (i >= 0) return PREFECTURES[i];
  }
  return String(name ?? "").trim() || String(code ?? "").trim();
}

/** +81 3-1234-5678 → 03-1234-5678（空白は詰める） */
export function domesticPhone(phone: unknown): string {
  let p = String(phone ?? "").trim();
  if (p.startsWith("+81")) p = `0${p.slice(3).replace(/^[\s-]+/, "")}`;
  return p.replace(/\s+/g, "");
}

type RawAddress = {
  zip?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  city?: string | null;
  address1?: string | null;
  address2?: string | null;
  company?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  countryCode?: string | null;
  countryCodeV2?: string | null;
} | null | undefined;

function isJapan(a: RawAddress): boolean {
  const cc = String(a?.countryCodeV2 ?? a?.countryCode ?? "JP").toUpperCase();
  return cc === "JP" || cc === "";
}

/** 住所を 1 行ずつ。日本は「県＋市区町村＋住所1」「住所2」。日本以外は Shopify の順のまま */
export function addressLines(a: RawAddress): string[] {
  if (!a) return [];
  const t = (v: unknown) => String(v ?? "").trim();
  if (isJapan(a)) {
    const first = `${japanesePrefecture(a.provinceCode, a.province)}${t(a.city)}${t(a.address1)}`;
    return [first, t(a.address2)].filter(Boolean);
  }
  return [t(a.address1), t(a.address2), [t(a.city), t(a.province)].filter(Boolean).join(" ")].filter(Boolean);
}

export function locationData(name: string, a: RawAddress): LocationData {
  return {
    name,
    zip: String(a?.zip ?? "").trim(),
    address_lines: addressLines(a),
    phone: domesticPhone(a?.phone),
  };
}

// ── 日付 ────────────────────────────────────────────────

function parts(iso: string, timezone: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
}

/** 2026年11月22日 20:58 */
export function dateTimeLabel(iso: string, timezone: string): string {
  const p = parts(iso, timezone);
  return p ? `${p.y}年${p.m}月${p.d}日 ${p.h}:${p.min}` : "";
}

/** 2026年11月22日 */
export function dateLabel(iso: string, timezone: string): string {
  const p = parts(iso, timezone);
  return p ? `${p.y}年${p.m}月${p.d}日` : "";
}

/** 2026-11-22 */
export function ymd(iso: string, timezone: string): string {
  const p = parts(iso, timezone);
  return p ? `${p.y}-${p.m}-${p.d}` : "";
}

// ── 販売・ギフト ────────────────────────────────────────

/**
 * 配送先は「保護されたお客様のデータ」なので、読めない店でも注文の印字を止めないよう別に読む。
 * 読めなければ配送先なし（配送の案内・配送先のブロックが出ないだけ）。
 */
export const LAYOUT_SHIPPING_ADDRESS_QUERY = `#graphql
  query ReceiptLayoutShippingAddress($id: ID!) {
    order(id: $id) {
      shippingAddress { zip province provinceCode city address1 address2 company name phone countryCodeV2 }
    }
  }
`;

type MoneyBag = { shopMoney?: { amount?: string | number | null; currencyCode?: string | null } | null } | null | undefined;
const money = (m: MoneyBag) => Number(m?.shopMoney?.amount ?? 0) || 0;
const currencyOf = (m: MoneyBag) => String(m?.shopMoney?.currencyCode ?? "") || "JPY";

/**
 * レイアウトの販売レシート・ギフトレシートで読む注文の項目。
 * 明細の `staffMember` は読まない: read_users の無い店（Ciara も）では注文の取得ごと失敗し、
 * 販売・ギフトがいつも前の印字に戻ってしまう（#83 の見直し P1。#84 と同じ理由）。
 * スタッフ名は明細のプロパティ（staffPropertyKeys）から出す。
 */
export const LAYOUT_ORDER_QUERY = `#graphql
  query ReceiptLayoutOrder($id: ID!) {
    shop { name currencyCode }
    order(id: $id) {
      id
      name
      createdAt
      note
      customAttributes { key value }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalTipReceivedSet { shopMoney { amount currencyCode } }
      taxesIncluded
      taxLines { title rate priceSet { shopMoney { amount currencyCode } } }
      shippingLine { title }
      retailLocation {
        id
        name
        address { zip province provinceCode city address1 address2 phone countryCode }
      }
      lineItems(first: 100) {
        nodes {
          title
          name
          variantTitle
          quantity
          sku
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountedUnitPriceSet { shopMoney { amount currencyCode } }
          variant { compareAtPrice }
          customAttributes { key value }
          discountAllocations {
            allocatedAmountSet { shopMoney { amount currencyCode } }
            discountApplication {
              __typename
              ... on DiscountCodeApplication { code }
              ... on ManualDiscountApplication { title }
              ... on AutomaticDiscountApplication { title }
              ... on ScriptDiscountApplication { title }
            }
          }
        }
        pageInfo { hasNextPage }
      }
      transactions(first: 50) {
        kind
        status
        gateway
        formattedGateway
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

export type LayoutOrderOptions = {
  timezone: string;
  /** スタッフ名を探す明細のプロパティ名（Ciara: スタッフ・担当スタッフ・販売スタッフ・staff） */
  staffPropertyKeys?: string[];
  /** 管理画面の「販売レシートの表題」など。空なら Shopify のストア名 */
  shopName?: string;
};

export const DEFAULT_STAFF_PROPERTY_KEYS = ["スタッフ", "担当スタッフ", "販売スタッフ", "staff"];

type RawLine = Record<string, unknown>;

function discountTitle(app: unknown): string {
  const a = (app ?? {}) as { code?: string; title?: string };
  return String(a.title ?? a.code ?? "").trim();
}

function mapKv(raw: unknown): KeyValue[] {
  return ((raw as { key?: string; value?: string }[] | null) ?? [])
    .map((a) => ({ key: String(a?.key ?? ""), value: String(a?.value ?? "") }))
    .filter((a) => a.key || a.value);
}

function lineItem(li: RawLine): OrderLineItem {
  const qty = Number(li.quantity ?? 0) || 0;
  const original = money(li.originalUnitPriceSet as MoneyBag);
  const discountedUnit = money(li.discountedUnitPriceSet as MoneyBag) || original;
  const allocations = ((li.discountAllocations as RawLine[] | null) ?? []).map((da) => ({
    amount: money(da.allocatedAmountSet as MoneyBag),
    title: discountTitle(da.discountApplication),
  }));
  const allocated = allocations.reduce((a, d) => a + d.amount, 0);
  // 明細の割引: 割り当て（注文の割引の按分を含む）があればそれ、無ければ単価の差
  const discount = allocated > 0 ? allocated : Math.max(0, Math.round((original - discountedUnit) * qty));
  const compare = Number((li.variant as { compareAtPrice?: string | null } | null)?.compareAtPrice ?? 0) || 0;
  const title = String(li.title ?? li.name ?? "");
  let variantTitle = String(li.variantTitle ?? "").trim();
  if (!variantTitle) {
    const name = String(li.name ?? "");
    if (name && title && name !== title && name.startsWith(title)) variantTitle = name.slice(title.length).replace(/^[\s\-–—]+/, "");
  }
  return {
    title,
    variant_title: variantTitle === "Default Title" ? "" : variantTitle,
    sku: String(li.sku ?? ""),
    quantity: qty,
    unit_price: original,
    line_total: Math.round(original * qty - discount),
    compare_at_price: compare > original ? compare : 0,
    discount,
    discount_label: [...new Set(allocations.map((d) => d.title).filter(Boolean))].join("・"),
    properties: mapKv(li.customAttributes),
  };
}

/** 明細のプロパティからスタッフ名を集める（重複は 1 回、" / " でつなぐ）。無ければ明細の担当者（今は注文の取得で読まないので、渡されたときだけ） */
export function staffNames(lines: RawLine[], keys: string[]): string {
  const want = new Set(keys.map((k) => k.trim().toLowerCase()).filter(Boolean));
  const fromProps: string[] = [];
  const fromStaff: string[] = [];
  for (const li of lines) {
    for (const a of mapKv(li.customAttributes)) {
      const v = a.value.trim();
      if (want.has(a.key.trim().toLowerCase()) && v && !fromProps.includes(v)) fromProps.push(v);
    }
    const s = String((li.staffMember as { name?: string } | null)?.name ?? "").trim();
    if (s && !fromStaff.includes(s)) fromStaff.push(s);
  }
  return (fromProps.length ? fromProps : fromStaff).join(" / ");
}

function taxLines(raw: unknown): TaxLine[] {
  return ((raw as RawLine[] | null) ?? [])
    .map((t) => {
      const rate = Number(t.rate ?? 0);
      return {
        title: String(t.title ?? "税"),
        rate_label: rate > 0 ? `${Math.round(rate * 1000) / 10}%` : "",
        amount: money(t.priceSet as MoneyBag),
      };
    })
    .filter((t) => t.amount !== 0);
}

function payments(raw: unknown): { payments: NamedAmount[]; change: number } {
  const txs = ((raw as RawLine[] | null) ?? []).filter((t) => String(t.status ?? "SUCCESS").toUpperCase() === "SUCCESS");
  const kind = (t: RawLine) => String(t.kind ?? "").toUpperCase();
  const sales = txs.filter((t) => kind(t) === "SALE" || kind(t) === "CAPTURE");
  const change = txs.filter((t) => kind(t) === "CHANGE").reduce((a, t) => a + Math.abs(money(t.amountSet as MoneyBag)), 0);
  return {
    payments: sales.map((t) => ({
      label: String(t.formattedGateway || t.gateway || "支払"),
      amount: money(t.amountSet as MoneyBag),
    })),
    change,
  };
}

/**
 * 小計の後に引く割引（Ciara の sales-receipt.liquid と同じ式）
 * = 小計 ＋ 送料 ＋ （税抜きの店なら）税 ＋ チップ − 合計。明細の割引は明細に出るので、ここには入らない
 */
export function orderLevelDiscount(order: RawLine): number {
  const taxes = order.taxesIncluded === false
    ? ((order.taxLines as RawLine[] | null) ?? []).reduce((a, t) => a + money(t.priceSet as MoneyBag), 0)
    : 0;
  const d =
    money(order.subtotalPriceSet as MoneyBag) +
    money(order.totalShippingPriceSet as MoneyBag) +
    taxes +
    money(order.totalTipReceivedSet as MoneyBag) -
    money(order.totalPriceSet as MoneyBag);
  return d > 0.005 ? Math.round(d * 100) / 100 : 0;
}

export function orderData(order: RawLine, opts: LayoutOrderOptions): OrderData {
  const lines = (((order.lineItems as { nodes?: RawLine[] } | null)?.nodes) ?? []) as RawLine[];
  const createdAt = String(order.createdAt ?? "");
  const ship = order.shippingAddress as RawAddress;
  const shippingAddress: ShippingAddress | null = ship
    ? {
        zip: String(ship.zip ?? "").trim(),
        lines: addressLines(ship),
        company: String(ship.company ?? "").trim(),
        name: String(ship.name ?? [ship.lastName, ship.firstName].filter(Boolean).join(" ")).trim(),
        phone: domesticPhone(ship.phone),
      }
    : null;
  const pay = payments(order.transactions);
  return {
    name: String(order.name ?? ""),
    created_at_label: dateTimeLabel(createdAt, opts.timezone),
    created_date: ymd(createdAt, opts.timezone),
    // POS の「お客様へ配送」は配送先と配送方法が付く
    is_shipping_order: Boolean(shippingAddress && order.shippingLine),
    shipping_address: shippingAddress,
    shipping: money(order.totalShippingPriceSet as MoneyBag),
    line_items: lines.map(lineItem),
    subtotal: money(order.subtotalPriceSet as MoneyBag),
    discounts: orderLevelDiscount(order),
    tax_lines: taxLines(order.taxLines),
    total: money(order.totalPriceSet as MoneyBag),
    payments: pay.payments,
    change: pay.change,
    attributes: mapKv(order.customAttributes),
    note: String(order.note ?? ""),
  };
}

export function salesTemplateData(
  raw: { shop?: { name?: string; currencyCode?: string } | null; order: RawLine },
  kind: "sales" | "gift",
  opts: LayoutOrderOptions & { printedAt: string; logoUrl?: string },
): ReceiptTemplateData {
  const order = orderData(raw.order, opts);
  const loc = raw.order.retailLocation as { name?: string; address?: RawAddress } | null;
  const lines = (((raw.order.lineItems as { nodes?: RawLine[] } | null)?.nodes) ?? []) as RawLine[];
  const common = {
    shop: {
      name: opts.shopName || String(raw.shop?.name ?? ""),
      currency: String(raw.shop?.currencyCode ?? "") || currencyOf(raw.order.totalPriceSet as MoneyBag),
      logo_url: opts.logoUrl ?? "",
    },
    location: locationData(String(loc?.name ?? ""), loc?.address),
    staff: { name: staffNames(lines, opts.staffPropertyKeys ?? DEFAULT_STAFF_PROPERTY_KEYS) },
    printed_at: dateTimeLabel(opts.printedAt, opts.timezone),
  };
  if (kind === "gift") {
    // ギフトレシートに金額・支払・メモ・属性は渡さない（今のギフトレシートと同じ）
    const giftOrder: OrderData = {
      ...order,
      line_items: order.line_items.map((li) => ({
        ...li,
        unit_price: 0,
        line_total: 0,
        compare_at_price: 0,
        discount: 0,
        discount_label: "",
        properties: [],
      })),
      subtotal: 0,
      discounts: 0,
      tax_lines: [],
      total: 0,
      shipping: 0,
      payments: [],
      change: 0,
      attributes: [],
      note: "",
    };
    return { ...common, kind: "gift", document: { title: "ギフトレシート" }, order: giftOrder };
  }
  return { ...common, kind: "sales", document: { title: `販売レシート ${order.name}` }, order };
}

// ── 精算・点検 ──────────────────────────────────────────

export type SettlementFigures = {
  total: number;
  netSales: number;
  tax: number;
  discounts: number;
  vipPointsUsed: number;
  refundTotal: number;
  orderCount: number;
  refundCount: number;
  itemCount: number;
  voucherChangeAmount: number;
};

export function settlementTemplateData(input: {
  figures: SettlementFigures;
  sections: SettlementSectionInput[];
  isInspection: boolean;
  title: string;
  targetDate: string;
  locationId: string;
  locationName: string;
  location: LocationData;
  shopName: string;
  currency: string;
  /** 発行した時（ISO）。無ければ印字した時 */
  issuedAt: string;
  printedAt: string;
  timezone: string;
  calc: SettlementCalcSettings;
  manualDelta?: number;
}): ReceiptTemplateData {
  const f = input.figures;
  const kindLabel = input.isInspection ? "点検" : "精算";
  const settlement: SettlementData = {
    title: input.title,
    is_inspection: input.isInspection,
    kind_label: kindLabel,
    period_label: input.targetDate,
    location_label: input.locationName,
    as_of: dateTimeLabel(input.issuedAt || input.printedAt, input.timezone),
    total: f.total,
    net_sales: f.netSales,
    tax: f.tax,
    discounts: f.discounts,
    vip_points_used: f.vipPointsUsed,
    refund_total: f.refundTotal,
    voucher_change: f.voucherChangeAmount,
    receipt_cash_manual_delta: input.manualDelta ?? 0,
    order_count: f.orderCount,
    refund_count: f.refundCount,
    item_count: f.itemCount,
    total_including_returns: f.total + f.refundTotal,
    cash_deposit: settlementCashDeposit(input.sections, {
      calc: input.calc,
      locationId: input.locationId,
      locationName: input.locationName,
      voucherChange: f.voucherChangeAmount,
      manualDelta: input.manualDelta,
    }),
    payments: orderSettlementPayments(input.sections, input.calc),
  };
  return {
    shop: { name: input.shopName, currency: input.currency || "JPY", logo_url: "" },
    location: input.location,
    staff: { name: "" },
    printed_at: dateTimeLabel(input.printedAt, input.timezone),
    document: { title: `${kindLabel}レシート` },
    kind: "settlement",
    settlement,
  };
}

// ── 領収書 ──────────────────────────────────────────────

/** 領収書で読む注文の項目（税の内訳と支払） */
export const LAYOUT_RECEIPT_ORDER_QUERY = `#graphql
  query ReceiptLayoutReceiptOrder($id: ID!) {
    shop { name currencyCode }
    order(id: $id) {
      id
      name
      createdAt
      taxLines { title rate priceSet { shopMoney { amount currencyCode } } }
      retailLocation {
        id
        name
        address { zip province provinceCode city address1 address2 phone countryCode }
      }
      transactions(first: 50) {
        kind
        status
        gateway
        formattedGateway
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

export function receiptTemplateData(input: {
  shop: { name?: string; currencyCode?: string } | null | undefined;
  order: RawLine | null | undefined;
  issue: {
    recipientName: string;
    proviso: string;
    amount: number;
    currency: string;
    orderName: string;
    createdAt: Date;
  };
  timezone: string;
  printedAt: string;
}): ReceiptTemplateData {
  const order = input.order ?? {};
  const loc = order.retailLocation as { name?: string; address?: RawAddress } | null | undefined;
  const iso = input.issue.createdAt.toISOString();
  const receipt: ReceiptData = {
    title: "領収書",
    // Shopify の POS のレシート番号は Admin API で読めないので注文番号にする
    number: input.issue.orderName,
    recipient: input.issue.recipientName,
    amount: input.issue.amount,
    proviso: input.issue.proviso,
    issue_date: dateLabel(iso, input.timezone),
    order_name: input.issue.orderName,
    tax_lines: taxLines(order.taxLines),
    payments: payments(order.transactions).payments,
  };
  return {
    shop: {
      name: String(input.shop?.name ?? ""),
      currency: input.issue.currency || String(input.shop?.currencyCode ?? "") || "JPY",
      logo_url: "",
    },
    location: locationData(String(loc?.name ?? ""), loc?.address),
    staff: { name: "" },
    printed_at: dateTimeLabel(input.printedAt, input.timezone),
    document: { title: "領収書" },
    kind: "receipt",
    receipt,
  };
}

// ── プレビューの見本（精算） ────────────────────────────

/** 見本の支払方法（並び順・まとめの行が分かるよう、わざと順をばらばらにしてある） */
export const SAMPLE_SETTLEMENT_SECTIONS: SettlementSectionInput[] = [
  { label: "電子マネー(QR)", net: 21900, txCount: 8, refund: 0, refundCount: 0 },
  { label: "クレジットカード", net: 58000, txCount: 15, refund: 0, refundCount: 0 },
  { label: "現金", net: 45300, txCount: 18, refund: 4950, refundCount: 1 },
  { label: "交通系ICカード決済", net: 3200, txCount: 1, refund: 0, refundCount: 0 },
];

/** 管理画面のプレビュー用。店の並び順・まとめの行・納金額の設定を見本に入れる */
export function sampleSettlementData(calc: SettlementCalcSettings, locationName = "サンプルストア 渋谷店"): ReceiptTemplateData {
  const base = sampleTemplateData("settlement");
  if (base.kind !== "settlement") return base;
  return {
    ...base,
    settlement: {
      ...base.settlement,
      location_label: locationName,
      cash_deposit: settlementCashDeposit(SAMPLE_SETTLEMENT_SECTIONS, {
        calc,
        locationId: "",
        locationName,
        voucherChange: base.settlement.voucher_change,
      }),
      payments: orderSettlementPayments(SAMPLE_SETTLEMENT_SECTIONS, calc),
    },
  };
}
