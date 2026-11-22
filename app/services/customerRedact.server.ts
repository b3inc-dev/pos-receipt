/**
 * customers/redact（お客様の削除の依頼）で、指定の注文に入っているお客様の情報を消す。
 *
 * T さんの決定（2026-11-23 2:35・連絡帳 #39）:
 * - 領収書の発行履歴（ReceiptIssue）の宛名は「空」にする。再印字のときは宛名の欄が空で出る
 *   （"[redacted]" の文字は出さない）。
 * - その注文の特殊返金（SpecialRefundEvent）のメモ（note）は消す（null）。金額・日時・支払方法・状態は残す
 *   （精算の数字は変わらない。note は集計に使っていない）。
 *
 * どちらも何度来ても同じ結果になる（すでに空なら同じ値を書くだけ）。
 * 記録（ログ）には件数だけを出す（宛名・メモの中身は出さない）。
 * 失敗したら投げる（ルートが 500 を返し、Shopify がもう一度送る）。
 *
 * #13（cursor/decision-audit-p2-debt-docs-0059）にも特殊返金のメモを消す直しがあるが、topic を
 * "customers/redact" と比べる古い形のままで動かない・"[redacted]" の文字を入れる。こちらを正とする
 * （DECISIONS D18）。
 */
import { expandOrderIdVariants } from "./gdprCustomerDataRequest.server";

type UpdateManyResult = { count?: number } | null | undefined;

/** ここで使う Prisma の形だけ（テストでは偽物を渡す） */
export type CustomerRedactDb = {
  shop: {
    findFirst(args: { where: { shopDomain: string } }): Promise<{ id: string } | null>;
  };
  receiptIssue: {
    updateMany(args: {
      where: { shopId: string; orderId: { in: string[] } };
      data: { recipientName: string };
    }): Promise<UpdateManyResult>;
  };
  specialRefundEvent: {
    updateMany(args: {
      where: { shopId: string; sourceOrderId: { in: string[] } };
      data: { note: null };
    }): Promise<UpdateManyResult>;
  };
};

export type CustomerRedactResult = {
  skipped?: "no_orders" | "no_shop";
  receiptIssuesRedacted: number;
  specialRefundNotesDeleted: number;
};

/** 領収書の宛名を消したあとの値（空。再印字で宛名の欄が空になる） */
export const REDACTED_RECIPIENT_NAME = "";

export async function redactCustomerData({
  db,
  shopDomain,
  ordersToRedact,
  log = console.info,
}: {
  db: CustomerRedactDb;
  shopDomain: string | null | undefined;
  ordersToRedact: unknown;
  log?: (...args: unknown[]) => void;
}): Promise<CustomerRedactResult> {
  const domain = String(shopDomain ?? "").trim();
  const orderIds = expandOrderIdVariants(
    Array.isArray(ordersToRedact) ? (ordersToRedact as Array<number | string>) : [],
  );

  if (orderIds.length === 0) {
    log(`[webhooks.compliance] customers/redact shop=${domain || "-"}: no orders; nothing changed`);
    return { skipped: "no_orders", receiptIssuesRedacted: 0, specialRefundNotesDeleted: 0 };
  }
  if (!domain) {
    log("[webhooks.compliance] customers/redact without shop domain; nothing changed");
    return { skipped: "no_shop", receiptIssuesRedacted: 0, specialRefundNotesDeleted: 0 };
  }

  const dbShop = await db.shop.findFirst({ where: { shopDomain: domain } });
  if (!dbShop) {
    log(`[webhooks.compliance] customers/redact shop=${domain}: shop not found; nothing changed`);
    return { skipped: "no_shop", receiptIssuesRedacted: 0, specialRefundNotesDeleted: 0 };
  }

  const [receipts, notes] = await Promise.all([
    db.receiptIssue.updateMany({
      where: { shopId: dbShop.id, orderId: { in: orderIds } },
      data: { recipientName: REDACTED_RECIPIENT_NAME },
    }),
    db.specialRefundEvent.updateMany({
      where: { shopId: dbShop.id, sourceOrderId: { in: orderIds } },
      data: { note: null },
    }),
  ]);

  const result: CustomerRedactResult = {
    receiptIssuesRedacted: receipts?.count ?? 0,
    specialRefundNotesDeleted: notes?.count ?? 0,
  };
  log(
    `[webhooks.compliance] customers/redact shop=${domain} orders=${orderIds.length} receiptIssues=${result.receiptIssuesRedacted} specialRefundNotes=${result.specialRefundNotesDeleted}`,
  );
  return result;
}
