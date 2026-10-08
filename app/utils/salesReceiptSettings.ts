/**
 * 販売レシート設定 — クライアント／サーバー共有（prisma 非依存）
 */

export const SALES_RECEIPT_SETTINGS_KEY = "sales_receipt_settings";

export interface SalesReceiptSettings {
  enabled: boolean;
  printOrderAttributes: boolean;
  printLineAttributes: boolean;
  paperWidthMm: 58 | 80;
  headerTitle: string;
  footerNote: string;
  layoutJson: {
    showSku: boolean;
    showPayments: boolean;
    showLocation: boolean;
  };
}

export const DEFAULT_SALES_RECEIPT_SETTINGS: SalesReceiptSettings = {
  enabled: true,
  printOrderAttributes: true,
  printLineAttributes: true,
  paperWidthMm: 80,
  headerTitle: "レシート",
  footerNote: "ご来店ありがとうございました",
  layoutJson: {
    showSku: false,
    showPayments: true,
    showLocation: true,
  },
};
