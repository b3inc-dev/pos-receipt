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
