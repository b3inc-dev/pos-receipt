/**
 * 設定と表示キャッシュの順序をそろえる。
 * ON/OFF保存もこの設定行を更新するため、保存済み設定を読んでから
 * 古い表示を書き込む競合を行ロックで防ぐ。外部通信はロック内に置かない。
 */
import prisma from "../db.server";
import { CIARA_VISIT_SYNC_KEY } from "../utils/ciaraVisitSync";
import { refreshCachedVisitors } from "./footfallWrite.server";

export async function refreshCiaraVisitCache(shopId: string, locationId: string, date: string): Promise<void> {
  // 全期間を1つのtransactionにせず、店×日ごとに短く保持する。
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ valueJson: string }[]>`
      SELECT "valueJson" FROM "AppSetting"
      WHERE "shopId" = ${shopId} AND "key" = ${CIARA_VISIT_SYNC_KEY}
      FOR UPDATE
    `;
    let enabled = false;
    try { enabled = JSON.parse(rows[0]?.valueJson ?? "{}")?.enabled === true; } catch {}
    await refreshCachedVisitors(tx, shopId, locationId, date, enabled);
  }, { maxWait: 5_000, timeout: 10_000 });
}
