/**
 * 入店数を書く・売上サマリーに出す数を決める共通の処理。
 * - POS の報告（/api/footfall）は FootfallReport に書く（人が入れた時刻 = 今）
 * - ciara-system の数（Ciara のカスタムアプリで「見せ合う」をオンにしたときだけ）は別の表 CiaraFootfallDaily にあり、
 *   売上サマリーを出すときに比べて、人があとから入れたほうを出す。POS の入店数は書き変えない
 * 書いたら売上サマリーの日次の控え（SalesSummaryCacheDaily）の入店数・購買率も、出す数で直す。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { getAppSetting } from "../utils/appSettings.server";
import { isInhouseMode } from "../utils/planFeatures.server";
import {
  CIARA_VISIT_SYNC_KEY,
  pickDisplayedVisitors,
  type CiaraVisitSyncSettings,
  type DisplayedVisitors,
} from "../utils/ciaraVisitSync";

type Db = PrismaClient | Prisma.TransactionClient;

/** ciara-system の数を売上サマリーに使うか（自社用で、見せ合うがオン） */
export async function ciaraVisitsShown(shopId: string): Promise<boolean> {
  if (!isInhouseMode()) return false;
  const saved = await getAppSetting<Partial<CiaraVisitSyncSettings>>(shopId, CIARA_VISIT_SYNC_KEY);
  return saved?.enabled === true;
}

/**
 * 売上サマリーに出す入店数（店 × 日）。locationIds は同じ店の ID の書き方ちがい（gid と数字）。
 * shown を渡すと設定を読み直さない。
 */
export async function getDisplayedVisitors(
  db: Db,
  shopId: string,
  locationIds: string[],
  date: string,
  shown?: boolean,
): Promise<DisplayedVisitors | null> {
  const useCiara = shown ?? (await ciaraVisitsShown(shopId));
  const [pos, ciara] = await Promise.all([
    db.footfallReport.findFirst({
      where: { shopId, locationId: { in: locationIds }, targetDate: date },
      select: { visitors: true, enteredAt: true },
    }),
    useCiara
      ? db.ciaraFootfallDaily.findFirst({
          where: { shopId, locationId: { in: locationIds }, targetDate: date },
          select: { visitors: true, reportedAt: true },
        })
      : Promise.resolve(null),
  ]);
  return pickDisplayedVisitors(
    pos ? { visitors: pos.visitors, enteredAt: pos.enteredAt.toISOString() } : null,
    ciara ? { visitors: ciara.visitors, reportedAt: ciara.reportedAt?.toISOString() ?? null } : null,
  );
}

/** 日次の控えの入店数・購買率を、出す数で直す（控えが無ければ何もしない。次に作るときに出す数で作る） */
export async function refreshCachedVisitors(db: Db, shopId: string, locationGid: string, date: string, shown?: boolean) {
  const where = { shopId_locationId_targetDate: { shopId, locationId: locationGid, targetDate: date } };
  const cached = await db.salesSummaryCacheDaily.findUnique({ where, select: { orders: true } });
  if (!cached) return;
  const numeric = locationGid.replace(/^gid:\/\/shopify\/Location\//, "");
  const shownVisitors = await getDisplayedVisitors(db, shopId, [locationGid, numeric], date, shown);
  const visitors = shownVisitors?.visitors ?? null;
  const conv = visitors && visitors > 0 ? cached.orders / visitors : null;
  await db.salesSummaryCacheDaily.update({ where, data: { visitors, conv } });
}

/** POS で報告した入店数を書く（いつも書く。入れた時刻 = 今） */
export async function writePosFootfall(
  db: Db,
  w: { shopId: string; locationGid: string; date: string; visitors: number; createdBy?: string | null },
): Promise<void> {
  const now = new Date();
  await db.footfallReport.upsert({
    where: { shopId_locationId_targetDate: { shopId: w.shopId, locationId: w.locationGid, targetDate: w.date } },
    update: { visitors: w.visitors, createdBy: w.createdBy ?? null, enteredAt: now },
    create: {
      shopId: w.shopId,
      locationId: w.locationGid,
      targetDate: w.date,
      visitors: w.visitors,
      createdBy: w.createdBy ?? null,
      enteredAt: now,
    },
  });
  await refreshCachedVisitors(db, w.shopId, w.locationGid, w.date);
}
