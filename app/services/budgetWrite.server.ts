/**
 * 日別予算（Budget）を書く共通の処理。日別一覧の保存と ciara-system からの取り込みで使う。
 * 売上サマリーの日次の控え（予算・予算比）も同じ値にする（POS の /api/budgets/upsert と同じ動き）。
 */
import type { Prisma } from "@prisma/client";
import { expandLocationIdsForBudgetQuery } from "../utils/salesSummaryBudgetFromDb.server";
import type { BudgetChange } from "../utils/budgetMonthGrid";

/** 1 店ぶんの変わった日を書く（取引の中で呼ぶ） */
export async function applyBudgetDayChanges(
  tx: Prisma.TransactionClient,
  shopId: string,
  locationGid: string,
  changes: BudgetChange[],
): Promise<void> {
  if (changes.length === 0) return;
  const legacyIds = expandLocationIdsForBudgetQuery(locationGid).filter((v) => v !== locationGid);
  const changedDates = changes.map((c) => c.date);
  // 数字だけの店舗 ID で入った古い行は、同じ日を書き直すときに GID の行へまとめる（二重に数えない）
  if (legacyIds.length > 0) {
    await tx.budget.deleteMany({
      where: { shopId, locationId: { in: legacyIds }, targetDate: { in: changedDates } },
    });
  }
  for (const c of changes) {
    if (c.after === null) {
      await tx.budget.deleteMany({ where: { shopId, locationId: locationGid, targetDate: c.date } });
    } else {
      await tx.budget.upsert({
        where: { shopId_locationId_targetDate: { shopId, locationId: locationGid, targetDate: c.date } },
        update: { amount: c.after },
        create: { shopId, locationId: locationGid, targetDate: c.date, amount: c.after },
      });
    }
  }
  const cached = await tx.salesSummaryCacheDaily.findMany({
    where: { shopId, locationId: locationGid, targetDate: { in: changedDates } },
    select: { id: true, targetDate: true, actual: true },
  });
  const afterByDate = new Map(changes.map((c) => [c.date, c.after]));
  for (const row of cached) {
    const budget = afterByDate.get(row.targetDate) ?? null;
    await tx.salesSummaryCacheDaily.update({
      where: { id: row.id },
      data: { budget, budgetRatio: budget && budget > 0 ? Number(row.actual) / budget : null },
    });
  }
}
