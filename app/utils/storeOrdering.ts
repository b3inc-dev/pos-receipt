/** 一覧の表示順。数字は全店の中の1始まりの位置。 */
export function moveStore(order: string[], id: string, position: number): string[] {
  if (!order.includes(id) || !Number.isInteger(position) || position < 1 || position > order.length) return order;
  const next = order.filter((v) => v !== id); next.splice(position - 1, 0, id); return next;
}
export function parseStoreOrder(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 10000 || value.some((id) => typeof id !== "string" || !/^\d+$/.test(id)) || new Set(value).size !== value.length) return null;
  return value;
}
