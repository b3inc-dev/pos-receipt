/**
 * 販売レシート設定の属性 ON/OFF（preferences C 共通キー）
 */
import { getAppSetting } from "./appSettings.server";
import {
  SALES_RECEIPT_SETTINGS_KEY,
  DEFAULT_SALES_RECEIPT_SETTINGS,
  type SalesReceiptSettings,
} from "./salesReceiptSettings";

export async function loadSalesReceiptAttrFlags(shopId: string): Promise<{
  printOrderAttributes: boolean;
  printLineAttributes: boolean;
}> {
  const saved =
    (await getAppSetting<Partial<SalesReceiptSettings>>(shopId, SALES_RECEIPT_SETTINGS_KEY)) ??
    {};
  return {
    printOrderAttributes:
      saved.printOrderAttributes ?? DEFAULT_SALES_RECEIPT_SETTINGS.printOrderAttributes,
    printLineAttributes:
      saved.printLineAttributes ?? DEFAULT_SALES_RECEIPT_SETTINGS.printLineAttributes,
  };
}
