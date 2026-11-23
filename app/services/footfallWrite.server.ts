/**
 * 入店数（FootfallReport）を書く共通の処理。POS の報告（/api/footfall）と ciara-system とそろえる処理で使う。
 * 書いたら売上サマリーの日次の控え（SalesSummaryCacheDaily）の入店数・購買率も直す（前から /api/footfall がしていたのと同じ）。
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export type FootfallWrite = {
  shopId: string;
  locationGid: string;
  date: string;
  visitors: number;
  /** "pos" = POS で報告、"ciara" = ciara-system から取り込み */
  source: "pos" | "ciara";
  /** 人が入れた時刻 */
  enteredAt: Date;
  createdBy?: string | null;
  /**
   * ciara-system から入れるとき: この時刻より後に POS で入れ直していたら書かない（あとから入れたほうを採る）。
   */
  onlyIfEnteredBefore?: Date;
};

/** 書いたら true。同じ数・POS のほうが新しいときは書かずに false */
export async function writeFootfallVisitors(db: Db, w: FootfallWrite): Promise<boolean> {
  const where = { shopId_locationId_targetDate: { shopId: w.shopId, locationId: w.locationGid, targetDate: w.date } };
  if (w.onlyIfEnteredBefore) {
    const existing = await db.footfallReport.findUnique({ where, select: { visitors: true, enteredAt: true } });
    if (existing && existing.visitors === w.visitors) return false;
    if (existing && existing.enteredAt.getTime() > w.onlyIfEnteredBefore.getTime()) return false;
  }
  const fromPos = w.source === "pos";
  const createdBy = w.createdBy === undefined ? (fromPos ? null : "ciara-system") : w.createdBy;
  await db.footfallReport.upsert({
    where,
    update: {
      visitors: w.visitors,
      createdBy,
      source: w.source,
      enteredAt: w.enteredAt,
      // POS で入れた数はまだ ciara-system に送っていない。ciara-system から入れた数は送らない
      pushedAt: fromPos ? null : new Date(),
    },
    create: {
      shopId: w.shopId,
      locationId: w.locationGid,
      targetDate: w.date,
      visitors: w.visitors,
      createdBy,
      source: w.source,
      enteredAt: w.enteredAt,
      pushedAt: fromPos ? null : new Date(),
    },
  });

  const cached = await db.salesSummaryCacheDaily.findUnique({ where, select: { orders: true } });
  if (cached) {
    const conv = w.visitors > 0 ? cached.orders / w.visitors : null;
    await db.salesSummaryCacheDaily.update({ where, data: { visitors: w.visitors, conv } });
  }
  return true;
}
