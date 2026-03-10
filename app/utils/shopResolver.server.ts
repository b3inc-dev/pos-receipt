/**
 * セッションのショップドメインから DB の Shop レコードを取得または作成する
 */
import prisma from "../db.server";

const SHOP_GID_QUERY = `#graphql
  query { shop { id } }
`;

export async function resolveShop(shopDomain: string, admin: { graphql: (query: string) => Promise<{ json: () => Promise<{ data?: { shop?: { id?: string } } }> }> }) {
  // 既存レコードを検索
  const existing = await prisma.shop.findFirst({ where: { shopDomain } });
  if (existing) return existing;

  // Shopify から Shop GID を取得
  const res = await admin.graphql(SHOP_GID_QUERY);
  const json = await res.json();
  const shopGid = json.data?.shop?.id ?? `gid://shopify/Shop/${shopDomain}`;

  return prisma.shop.upsert({
    where: { shopifyShopGid: shopGid },
    create: { shopifyShopGid: shopGid, shopDomain, planCode: "standard" },
    update: { shopDomain },
  });
}
