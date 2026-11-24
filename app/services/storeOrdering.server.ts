import prisma from "../db.server";
import { locationNumericId } from "../utils/locationDefaults";
import { parseStoreOrder } from "../utils/storeOrdering";

export class StoreOrderError extends Error {}

export async function saveStoreOrder(shopId: string, input: unknown, baseline: unknown) {
  const order = parseStoreOrder(input);
  if (!order || !baseline || typeof baseline !== "object" || Array.isArray(baseline)) throw new StoreOrderError("表示順を読み取れませんでした。画面を開き直してください。");
  const original = baseline as Record<string, unknown>;
  if (Object.keys(original).length !== order.length || Object.keys(original).some((id) => !order.includes(id))) throw new StoreOrderError("店舗一覧の表示順が正しくありません。画面を開き直してください。");
  for (const id of order) if (!Number.isInteger(original[id])) throw new StoreOrderError("表示順の保存値が正しくありません。画面を開き直してください。");
  await prisma.$transaction(async (tx) => {
    const rows = await tx.location.findMany({ where: { shopId, shopifyLocationGid: { in: order.map((id) => `gid://shopify/Location/${id}`) } }, select: { id: true, shopifyLocationGid: true, sortOrder: true } });
    const byId = new Map(rows.map((row) => [locationNumericId(row.shopifyLocationGid), row]));
    if (rows.length !== order.length || order.some((id) => !byId.has(id))) throw new StoreOrderError("店舗一覧が更新されました。画面を開き直してから並び替えてください。");
    for (let index = 0; index < order.length; index++) {
      const id = order[index]; const row = byId.get(id)!;
      if (row.sortOrder !== original[id]) throw new StoreOrderError("別の画面で表示順が変更されました。画面を開き直してください。");
      const result = await tx.location.updateMany({ where: { id: row.id, shopId, sortOrder: row.sortOrder }, data: { sortOrder: index + 1 } });
      if (result.count !== 1) throw new StoreOrderError("表示順が変更されたため保存していません。画面を開き直してください。");
    }
  });
  return order;
}
