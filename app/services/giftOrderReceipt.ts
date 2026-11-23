import { renderPrintReceiptHtml } from "./printReceiptHtml";

import type { GiftLayout } from "../utils/salesReceiptSettings";

type GiftLine = { name: string; quantity: number };
type GiftPage = {
  name: string;
  lineItems: { nodes: GiftLine[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};

// Money, payments, notes and custom attributes never enter the gift template.
export const GIFT_ORDER_QUERY = `#graphql
  query GiftReceiptOrder($id: ID!, $after: String) {
    order(id: $id) {
      name
      lineItems(first: 100, after: $after) {
        nodes { name quantity }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export async function giftOrderHtml(
  readPage: (cursor: string | null) => Promise<GiftPage | null>,
  paperWidthMm: 58 | 80,
  layout?: GiftLayout,
): Promise<string | null> {
  const items: GiftLine[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await readPage(cursor);
    if (!page) return null;
    for (const { name, quantity } of page.lineItems.nodes) items.push({ name, quantity });
    const { hasNextPage, endCursor } = page.lineItems.pageInfo;
    if (!hasNextPage) {
      return renderPrintReceiptHtml({ kind: "gift", orderName: page.name, items, paperWidthMm, layout });
    }
    if (!endCursor || seen.has(endCursor)) throw new Error("注文のすべての明細を取得できませんでした。");
    seen.add(endCursor);
    cursor = endCursor;
  }
}
