/**
 * 精算注文の Shopify 同期可否（管理画面設定 × printMode × Printing API）
 *
 * Printing API 優先（preferPrintingApi && settlementPrintingApiEnabled）のときは
 * 印字用途の SETTLEMENT 注文作成をスキップする。
 * 監査アーカイブ用オプトイン（createSettlementOrderWhenPrinting が保存済みで true）のみ尊重。
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

/**
 * Printing API が精算印字の主経路か。
 * 保存値が無いときは DEFAULT_PRINT_SETTINGS（どちらも true）を使う。
 */
export function isSettlementPrintingApiPrimary(
  printSaved: Partial<PrintSettings> | null | undefined,
): boolean {
  const prefer =
    printSaved?.preferPrintingApi ?? DEFAULT_PRINT_SETTINGS.preferPrintingApi;
  const settlementEnabled =
    printSaved?.settlementPrintingApiEnabled ??
    DEFAULT_PRINT_SETTINGS.settlementPrintingApiEnabled;
  return prefer === true && settlementEnabled === true;
}

/**
 * SETTLEMENT 注文を作るか。
 * - Printing 主経路: createSettlementOrderWhenPrinting が**保存済みで true** のときだけ（アーカイブオプトイン）
 * - それ以外（旧 order_based 印字）: 従来どおり未保存は ON（!== false）
 */
export function shouldCreateSettlementOrder(
  settlement: SettlementSettings,
  printSaved: Partial<PrintSettings> | null | undefined,
): boolean {
  if (settlement.orderBasedCreateSettlementOrderEnabled === false) {
    return false;
  }
  if (isSettlementPrintingApiPrimary(printSaved)) {
    // 未保存（undefined）→ スキップ。明示 true のみアーカイブ作成。
    return printSaved?.createSettlementOrderWhenPrinting === true;
  }
  return printSaved?.createSettlementOrderWhenPrinting !== false;
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

  const createOrder = shouldCreateSettlementOrder(settlement, printSaved);

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
