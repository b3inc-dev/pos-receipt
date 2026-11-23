/**
 * 再印字・再精算の印: 設定の読み込みと、領収書・販売・ギフトを印刷した記録（PrintRecord）
 * 印字の飾りだけ。金額・件数・Shopify への書き込みには関係しない。
 */
import prisma from "../db.server";
import { getAppSetting } from "../utils/appSettings.server";
import {
  normalizePrintMarkSettings,
  PRINT_MARK_SETTINGS_KEY,
  printRecordTargetId,
  type PrintMarkSettings,
  type PrintRecordKind,
} from "./printMarks";

export async function getPrintMarkSettings(shopId: string): Promise<PrintMarkSettings> {
  return normalizePrintMarkSettings(await getAppSetting<unknown>(shopId, PRINT_MARK_SETTINGS_KEY));
}

/** 一度でも印刷を受け付けたか（次の印刷は再印字） */
export async function wasPrinted(shopId: string, kind: PrintRecordKind, id: string): Promise<boolean> {
  const row = await prisma.printRecord.findUnique({
    where: { shopId_kind_targetId: { shopId, kind, targetId: printRecordTargetId(kind, id) } },
    select: { id: true },
  });
  return row != null;
}

/** POS が印刷を受け付けたことを残す（2 回目からは回数と最後の時刻だけ増やす） */
export async function recordPrinted(shopId: string, kind: PrintRecordKind, id: string): Promise<void> {
  const targetId = printRecordTargetId(kind, id);
  const now = new Date();
  await prisma.printRecord.upsert({
    where: { shopId_kind_targetId: { shopId, kind, targetId } },
    create: { shopId, kind, targetId, printCount: 1, firstPrintedAt: now, lastPrintedAt: now },
    update: { printCount: { increment: 1 }, lastPrintedAt: now },
  });
}
