/**
 * 入店数（FootfallReport）を書く共通の処理。POS の報告（/api/footfall）と、ciara-system の数を読んで入れる処理で使う。
 * 書いたら売上サマリーの日次の控え（SalesSummaryCacheDaily）の入店数・購買率も直す（前から /api/footfall がしていたのと同じ）。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

type Base = { shopId: string; locationGid: string; date: string; visitors: number };

async function refreshCache(db: Db, w: Base) {
  const where = { shopId_locationId_targetDate: { shopId: w.shopId, locationId: w.locationGid, targetDate: w.date } };
  const cached = await db.salesSummaryCacheDaily.findUnique({ where, select: { orders: true } });
  if (cached) {
    const conv = w.visitors > 0 ? cached.orders / w.visitors : null;
    await db.salesSummaryCacheDaily.update({ where, data: { visitors: w.visitors, conv } });
  }
}

/** POS で報告した入店数を書く（いつも書く。入れた時刻 = 今） */
export async function writePosFootfall(db: Db, w: Base & { createdBy?: string | null }): Promise<void> {
  const now = new Date();
  await db.footfallReport.upsert({
    where: { shopId_locationId_targetDate: { shopId: w.shopId, locationId: w.locationGid, targetDate: w.date } },
    update: { visitors: w.visitors, createdBy: w.createdBy ?? null, source: "pos", enteredAt: now },
    create: {
      shopId: w.shopId,
      locationId: w.locationGid,
      targetDate: w.date,
      visitors: w.visitors,
      createdBy: w.createdBy ?? null,
      source: "pos",
      enteredAt: now,
    },
  });
  await refreshCache(db, w);
}

/**
 * ciara-system の数を入れる。確かめと書き込みは 1 つの文で行う（読んだ直後に POS で報告されても上書きしない）。
 * 書くのは、行が無い・前に ciara-system から入れた数・POS の数より ciara-system で人があとから入れたときだけ。同じ数は書かない。
 * 書いたら true。
 */
export async function writeCiaraFootfall(db: Db, w: Base & { enteredAt: Date }): Promise<boolean> {
  const updated = await db.footfallReport.updateMany({
    where: {
      shopId: w.shopId,
      locationId: w.locationGid,
      targetDate: w.date,
      visitors: { not: w.visitors },
      OR: [{ source: { not: "pos" } }, { enteredAt: { lt: w.enteredAt } }],
    },
    data: { visitors: w.visitors, source: "ciara", enteredAt: w.enteredAt, createdBy: "ciara-system" },
  });
  if (updated.count === 0) {
    const exists = await db.footfallReport.findUnique({
      where: { shopId_locationId_targetDate: { shopId: w.shopId, locationId: w.locationGid, targetDate: w.date } },
      select: { id: true },
    });
    if (exists) return false;
    try {
      await db.footfallReport.create({
        data: {
          shopId: w.shopId,
          locationId: w.locationGid,
          targetDate: w.date,
          visitors: w.visitors,
          source: "ciara",
          enteredAt: w.enteredAt,
          createdBy: "ciara-system",
        },
      });
    } catch (e) {
      // 同じ時に POS で報告された（POS の数を残す）
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
      throw e;
    }
  }
  await refreshCache(db, w);
  return true;
}
