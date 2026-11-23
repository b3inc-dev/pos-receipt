/**
 * 精算注文の Shopify 同期。
 * 印字一本化後は常に作成しない。保存済みの order_based フラグは読み取っても出力に使わない。
 */
import { shouldCreateSettlementShopifyOrder } from "./printUnification.server";

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
  _shopId: string,
  printMode: string,
): Promise<SettlementOrderSyncOptions> {
  const createOrder = shouldCreateSettlementShopifyOrder(printMode);
  return {
    createOrder,
    attachNote: false,
    attachMetafields: false,
  };
}
