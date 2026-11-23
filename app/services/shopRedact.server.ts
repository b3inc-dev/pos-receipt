/**
 * shop/redact（アンインストールの 48 時間後）で、その店のデータを消す。
 *
 * - 使用量の記録（AppUsageReport。超えたロケーションを App Events で報告した行）を消す（T さん 11/23 1:50。POS Stock と同じ）
 * - セッションを消す
 * - Shop の行を消す（ほかの表は onDelete: Cascade で一緒に消える）
 *
 * アンインストールの webhook では AppUsageReport を消さない（48 時間のうちに入れ直したとき、同じ期間を二重に報告しないため）。
 * 消す前に「入れ直していないか」を isShopStillInstalled で確かめ、入れ直した店なら何も消さない（Location Stock と同じ）。
 * 確かめられないとき・消すのに失敗したときは投げる（ルートが 500 を返し、Shopify がもう一度送る）。
 * どれも何度消しても同じ結果になる。記録（ログ）には件数だけを出す。
 */

type DeleteManyResult = { count?: number } | null | undefined;

/** ここで使う Prisma の形だけ（テストでは偽物を渡す） */
export type ShopRedactDb = {
  appUsageReport: { deleteMany(args: { where: { shop: string } }): Promise<DeleteManyResult> };
  session: { deleteMany(args: { where: { shop: string } }): Promise<DeleteManyResult> };
  shop: {
    findFirst(args: { where: { shopDomain: string } }): Promise<{ id: string } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
};

export type ShopRedactResult = {
  skipped?: "no_shop" | "reinstalled";
  usageReportsDeleted: number;
  sessionsDeleted: number;
  shopDeleted: boolean;
};

export async function redactShopData({
  db,
  shopDomain,
  isShopStillInstalled,
  log = console.info,
}: {
  db: ShopRedactDb;
  shopDomain: string | null | undefined;
  /** true = 今も入っている（入れ直した）。消さない */
  isShopStillInstalled: (shop: string) => Promise<boolean>;
  log?: (...args: unknown[]) => void;
}): Promise<ShopRedactResult> {
  const domain = String(shopDomain ?? "").trim();
  if (!domain) {
    log("[webhooks.compliance] shop/redact without shop domain; nothing deleted");
    return { skipped: "no_shop", usageReportsDeleted: 0, sessionsDeleted: 0, shopDeleted: false };
  }

  if (typeof isShopStillInstalled !== "function") {
    throw new Error("isShopStillInstalled is required for shop/redact");
  }
  if (await isShopStillInstalled(domain)) {
    log(`[webhooks.compliance] shop/redact shop=${domain}: app is installed again; nothing deleted`);
    return { skipped: "reinstalled", usageReportsDeleted: 0, sessionsDeleted: 0, shopDeleted: false };
  }

  const usage = await db.appUsageReport.deleteMany({ where: { shop: domain } });
  const sessions = await db.session.deleteMany({ where: { shop: domain } });

  let shopDeleted = false;
  const dbShop = await db.shop.findFirst({ where: { shopDomain: domain } });
  if (dbShop) {
    await db.shop.delete({ where: { id: dbShop.id } });
    shopDeleted = true;
  }

  const result: ShopRedactResult = {
    usageReportsDeleted: usage?.count ?? 0,
    sessionsDeleted: sessions?.count ?? 0,
    shopDeleted,
  };
  log(
    `[webhooks.compliance] shop/redact shop=${domain} usageReports=${result.usageReportsDeleted} sessions=${result.sessionsDeleted} shopRow=${shopDeleted ? 1 : 0}`,
  );
  return result;
}
