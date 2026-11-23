/**
 * お客様の削除の依頼（customers/redact）で、領収書の発行履歴から宛名を消す。
 * 宛名は列（recipientName）と、発行時の紙面（printSnapshotJson の HTML）の両方にあるので、両方から消す。
 * 金額・注文番号・但し書きなど、宛名以外は残す（精算・帳簿のため）。
 */
import type { PrismaClient } from "@prisma/client";
import { REDACTED_RECIPIENT_NAME, redactReceiptPrintSnapshot } from "./receiptPrintSnapshot.server";

/** prisma（テストでは同じ形の偽物）。使うのは receiptIssue の findMany と update だけ */
export type ReceiptRedactDb = Pick<PrismaClient, "receiptIssue">;

/** 消した件数を返す */
export async function redactReceiptIssuesForOrders(
  db: ReceiptRedactDb,
  shopId: string,
  orderIds: string[],
): Promise<number> {
  if (orderIds.length === 0) return 0;
  const rows = await db.receiptIssue.findMany({
    where: { shopId, orderId: { in: orderIds } },
    select: {
      id: true,
      recipientName: true,
      proviso: true,
      amount: true,
      currency: true,
      createdAt: true,
      orderName: true,
      printSnapshotJson: true,
    },
  });
  for (const row of rows) {
    await db.receiptIssue.update({
      where: { id: row.id },
      data: {
        recipientName: REDACTED_RECIPIENT_NAME,
        printSnapshotJson: redactReceiptPrintSnapshot(row.printSnapshotJson, row),
      },
    });
  }
  return rows.length;
}
