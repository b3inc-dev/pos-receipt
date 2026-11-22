/**
 * 精算注文の Shopify 同期可否（管理画面設定 × printMode × Printing API）
 *
 * 「精算注文を作成」（createSettlementOrderWhenPrinting）は、保存が無ければ ON。
 * 管理画面の印字設定は保存が無いと DEFAULT_PRINT_SETTINGS（true）でチェックが入って見えるので、
 * サーバーも同じ初めの値にそろえる（今の本番の動き = 作る、を続ける）。
 * 作りたくない店は、チェックを外して保存する（明示 false）。
 * Printing API が主の経路かどうかでは変えない。
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
 * - 精算設定 orderBasedCreateSettlementOrderEnabled が false → 作らない
 * - 印字設定 createSettlementOrderWhenPrinting が保存済みで false → 作らない
 * - それ以外（保存が無い・true）→ 作る（管理画面の見た目＝初めの値 ON と同じ）
 */
export function shouldCreateSettlementOrder(
  settlement: SettlementSettings,
  printSaved: Partial<PrintSettings> | null | undefined,
): boolean {
  if (settlement.orderBasedCreateSettlementOrderEnabled === false) {
    return false;
  }
  const createWhenPrinting =
    printSaved?.createSettlementOrderWhenPrinting ??
    DEFAULT_PRINT_SETTINGS.createSettlementOrderWhenPrinting;
  return createWhenPrinting !== false;
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
