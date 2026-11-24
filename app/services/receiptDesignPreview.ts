import { renderPrintReceiptHtml, settlementPreviewToPrintModel } from "./printReceiptHtml";
import type { SalesReceiptSettings, GiftLayout } from "../utils/salesReceiptSettings";
import type { ReceiptDesignBasics } from "./receiptDesignSettings";
import type { ReceiptKind } from "./receiptLayoutSchema";
import { sampleTemplateData } from "./receiptLayoutData";
export function salesDesignSampleHtml(settings: SalesReceiptSettings, gift: boolean, layout: GiftLayout): string {
  if (gift) {
    return renderPrintReceiptHtml({
      kind: "gift", layout, orderName: "#1042", paperWidthMm: settings.paperWidthMm,
      items: [{ name: "サンプル商品 A（M / 黒）", quantity: 1 }, { name: "サンプル商品 B", quantity: 2 }],
    });
  }
  // 実印字（buildSalesReceiptPrintModel）と同じく layoutJson フラグで描画制御する
  return renderPrintReceiptHtml({
    kind: "sales",
    shopName: settings.headerTitle || "レシート",
    orderName: "#1042",
    createdAtLabel: "2026/10/08 13:45",
    locationName: "渋谷店",
    currency: "JPY",
    subtotal: 3300,
    tax: 300,
    discounts: 200,
    total: 3400,
    lineItems: [
      {
        title: "サンプル商品 A",
        variantTitle: "M / 黒",
        quantity: 1,
        unitPrice: 2000,
        lineTotal: 2000,
        sku: "SKU-A",
        customAttributes: settings.printLineAttributes
          ? [
              { key: "名入れ", value: "太郎" },
              { key: "包装", value: "あり" },
            ]
          : [],
      },
      {
        title: "サンプル商品 B",
        quantity: 2,
        unitPrice: 750,
        lineTotal: 1500,
        sku: "SKU-B",
        customAttributes: [],
      },
    ],
    orderAttributes: settings.printOrderAttributes
      ? [
          { key: "来店目的", value: "ギフト" },
          { key: "スタッフメモ", value: "袋不要" },
        ]
      : [],
    payments: [
      { label: "現金", amount: 2000 },
      { label: "クレジットカード", amount: 1400 },
    ],
    footerNote: settings.footerNote,
    showOrderAttributes: settings.printOrderAttributes,
    showLineAttributes: settings.printLineAttributes,
    showSku: !!settings.layoutJson.showSku,
    showPayments: settings.layoutJson.showPayments !== false,
    showLocation: settings.layoutJson.showLocation !== false,
    paperWidthMm: settings.paperWidthMm,
  });
}


export function standardDesignPreview(kind: ReceiptKind, basics: ReceiptDesignBasics): string {
  if (kind === "sales" || kind === "gift") return salesDesignSampleHtml({ ...basics.sales!, paperWidthMm: basics.paperWidthMm }, kind === "gift", basics.gift!);
  if (kind === "receipt") {
    const t = basics.receipt!;
    // 発行時スナップショットの標準レンダラと同じ入力。未対応の旧表示設定を推測で印字しない。
    return renderPrintReceiptHtml({ kind: "receipt", title: "領　収　書", recipientName: "山田 太郎", proviso: t.defaultProviso,
      amount: 5400, currency: "JPY", issueDate: "2026-11-24", orderName: "#1042", locationName: "サンプルストア 渋谷店",
      companyName: t.companyName, address: t.address, phone: t.phone, showOrderNumber: t.showOrderNumber, showDate: t.showDate, paperWidthMm: basics.paperWidthMm });
  }
  return renderPrintReceiptHtml(settlementPreviewToPrintModel({
    targetDate: "2026-11-24", locationName: "サンプルストア 渋谷店", currency: "JPY", total: 125000, netSales: 113636, tax: 11364,
    discounts: 2000, refundTotal: 3000, orderCount: 42, refundCount: 2, itemCount: 87,
    voucherChangeAmount: basics.showVoucherChange ? 500 : 0,
    paymentSections: [{label:"現金",net:45000,txCount:18,refund:0,refundCount:0},{label:"クレジットカード",net:80000,txCount:24,refund:3000,refundCount:2}],
  }, {isInspection: basics.isInspection, paperWidthMm: basics.paperWidthMm}));
}
