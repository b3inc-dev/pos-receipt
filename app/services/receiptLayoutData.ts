/**
 * テンプレートに渡すデータ（Liquid の変数）の形と、プレビュー用の見本
 *
 * 名前は Shopify のレシートの Liquid と Ciara の精算メタフィールド（settlement.*）に寄せた。
 * 金額は数値（円）、日付は表示用に整えた文字で渡す（タイムゾーンの扱いを印字側でそろえるため）。
 * 印字の道（販売・精算・領収書・ギフト）からこの形に変える部分は、#22 が main に入ってから作る。
 */
import type { ReceiptKind } from "./receiptLayoutSchema";

export type NamedAmount = { label: string; amount: number };
export type TaxLine = { title: string; rate_label: string; amount: number };
export type KeyValue = { key: string; value: string };

export type ShopData = { name: string; currency: string };
export type LocationData = {
  name: string;
  zip: string;
  /** 住所を 1 行ずつ */
  address_lines: string[];
  phone: string;
};

export type OrderLineItem = {
  title: string;
  variant_title: string;
  sku: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  discount: number;
  discount_label: string;
  properties: KeyValue[];
};

export type OrderData = {
  name: string;
  created_at_label: string;
  line_items: OrderLineItem[];
  subtotal: number;
  discounts: number;
  tax_lines: TaxLine[];
  total: number;
  payments: NamedAmount[];
  change: number;
  attributes: KeyValue[];
  note: string;
};

export type SettlementPayment = {
  label: string;
  net: number;
  count: number;
  refund: number;
  refund_count: number;
};

export type SettlementData = {
  title: string;
  is_inspection: boolean;
  period_label: string;
  location_label: string;
  as_of: string;
  total: number;
  net_sales: number;
  tax: number;
  discounts: number;
  vip_points_used: number;
  refund_total: number;
  voucher_change: number;
  receipt_cash_manual_delta: number;
  order_count: number;
  refund_count: number;
  item_count: number;
  payments: SettlementPayment[];
};

export type ReceiptData = {
  title: string;
  number: string;
  recipient: string;
  amount: number;
  proviso: string;
  issue_date: string;
  order_name: string;
  tax_lines: TaxLine[];
  payments: NamedAmount[];
};

type Common = {
  shop: ShopData;
  location: LocationData;
  staff: { name: string };
  printed_at: string;
  document: { title: string };
};

export type ReceiptTemplateData =
  | (Common & { kind: "sales"; order: OrderData })
  | (Common & { kind: "gift"; order: OrderData })
  | (Common & { kind: "settlement"; settlement: SettlementData })
  | (Common & { kind: "receipt"; receipt: ReceiptData });

const SAMPLE_COMMON: Common = {
  shop: { name: "サンプルストア", currency: "JPY" },
  location: {
    name: "サンプルストア 渋谷店",
    zip: "150-0001",
    address_lines: ["東京都渋谷区神宮前1-2-3", "サンプルビル 2F"],
    phone: "03-1234-5678",
  },
  staff: { name: "山田" },
  printed_at: "2026年11月22日 20:58",
  document: { title: "" },
};

const SAMPLE_ORDER: OrderData = {
  name: "#1042",
  created_at_label: "2026年11月22日 20:58",
  line_items: [
    {
      title: "シェルインナーシート",
      variant_title: "ShellBlue / iPhone15",
      sku: "SKU-0001-BL-15",
      quantity: 1,
      unit_price: 990,
      line_total: 990,
      discount: 0,
      discount_label: "",
      properties: [],
    },
    {
      title: "スマホケース",
      variant_title: "Clear / iPhone15",
      sku: "SKU-0002-CL-15",
      quantity: 2,
      unit_price: 2200,
      line_total: 3960,
      discount: 440,
      discount_label: "セット割",
      properties: [{ key: "ギフト包装", value: "あり" }],
    },
  ],
  subtotal: 4950,
  // 商品ごとの割引は明細に出す。注文全体の割引はこの見本ではなし
  discounts: 0,
  tax_lines: [{ title: "消費税", rate_label: "10%", amount: 450 }],
  total: 4950,
  payments: [
    { label: "現金", amount: 5000 },
  ],
  change: 50,
  attributes: [{ key: "販売担当", value: "山田" }],
  note: "",
};

/** プレビューの見本のデータ（実際の注文ではない） */
export function sampleTemplateData(kind: ReceiptKind): ReceiptTemplateData {
  switch (kind) {
    case "sales":
      return { ...SAMPLE_COMMON, kind, document: { title: `販売レシート ${SAMPLE_ORDER.name}` }, order: SAMPLE_ORDER };
    case "gift":
      return { ...SAMPLE_COMMON, kind, document: { title: "ギフトレシート" }, order: SAMPLE_ORDER };
    case "settlement":
      return {
        ...SAMPLE_COMMON,
        kind,
        document: { title: "精算レシート" },
        settlement: {
          title: "【精算レシート】",
          is_inspection: false,
          period_label: "2026-11-22",
          location_label: "サンプルストア 渋谷店",
          as_of: "2026-11-22 21:05",
          total: 128400,
          net_sales: 116728,
          tax: 11672,
          discounts: 3200,
          vip_points_used: 500,
          refund_total: 4950,
          voucher_change: 0,
          receipt_cash_manual_delta: 0,
          order_count: 42,
          refund_count: 1,
          item_count: 57,
          payments: [
            { label: "現金", net: 45300, count: 18, refund: 4950, refund_count: 1 },
            { label: "クレジットカード", net: 61200, count: 16, refund: 0, refund_count: 0 },
            { label: "電子マネー(QR)", net: 21900, count: 8, refund: 0, refund_count: 0 },
          ],
        },
      };
    case "receipt":
      return {
        ...SAMPLE_COMMON,
        kind,
        document: { title: "領収書" },
        receipt: {
          title: "領収書",
          number: "R-000123",
          recipient: "山田 太郎",
          amount: 4950,
          proviso: "お品代",
          issue_date: "2026年11月22日",
          order_name: "#1042",
          tax_lines: [{ title: "消費税", rate_label: "10%", amount: 450 }],
          payments: [{ label: "現金", amount: 4950 }],
        },
      };
  }
}
