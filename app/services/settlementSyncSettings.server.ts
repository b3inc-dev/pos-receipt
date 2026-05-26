/**
 * 精算注文の Shopify 同期可否（管理画面設定 × printMode）
 */
import {
  getAppSetting,
  SETTLEMENT_SETTINGS_KEY,
  DEFAULT_SETTLEMENT_SETTINGS,
  PRINT_SETTINGS_KEY,
  DEFAULT_PRINT_SETTINGS,
  type SettlementSettings,
  type PrintSettings,
} from "../utils/appSettings.server";

export interface SettlementOrderSyncOptions {
  createOrder: boolean;
  attachNote: boolean;
  attachMetafields: boolean;
}

export async function resolveSettlementOrderSyncOptions(
  shopId: string,
  printMode: string,
): Promise<SettlementOrderSyncOptions> {
  if (printMode !== "order_based") {
    return { createOrder: false, attachNote: false, attachMetafields: false };
  }

  const settlementSaved = await getAppSetting<Partial<SettlementSettings>>(
    shopId,
    SETTLEMENT_SETTINGS_KEY,
  );
  const printSaved = await getAppSetting<Partial<PrintSettings>>(shopId, PRINT_SETTINGS_KEY);
  const settlement = { ...DEFAULT_SETTLEMENT_SETTINGS, ...settlementSaved };
  const print = { ...DEFAULT_PRINT_SETTINGS, ...printSaved };

  const createOrder =
    settlement.orderBasedCreateSettlementOrderEnabled !== false &&
    print.createSettlementOrderWhenPrinting !== false;

  return {
    createOrder,
    attachNote:
      createOrder &&
      print.attachSettlementNoteToOrder !== false &&
      settlement.orderBasedAttachNoteEnabled !== false,
    attachMetafields:
      createOrder &&
      print.attachSettlementMetafieldsToOrder !== false &&
      settlement.orderBasedAttachMetafieldsEnabled !== false,
  };
}
