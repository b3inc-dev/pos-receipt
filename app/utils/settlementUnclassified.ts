/**
 * 保存済みの精算（paymentSectionsJson）に「未分類」の支払方法の行があるか。
 * 特殊返金の返金方法が支払方法マスタに無いとき、精算エンジンはその返金を「未分類」の行に入れる
 * （specialRefundOverlayPure.server.ts の UNMATCHED_REFUND_SECTION_KEY）。精算履歴で目印を出すのに使う。
 */
export const UNCLASSIFIED_PAYMENT_SECTION_KEY = "未分類";

export function hasUnclassifiedPaymentSection(paymentSectionsJson: string | null | undefined): boolean {
  if (!paymentSectionsJson) return false;
  let rows: unknown;
  try {
    rows = JSON.parse(paymentSectionsJson);
  } catch {
    return false;
  }
  // 前の形は行の配列。#22（印字の一本化）の形は { format, snapshot, sections }。どちらも読む。
  // #22 が入ったら settlementPrintSnapshot.server.ts の parsePaymentSectionsJson に寄せる。
  if (rows && typeof rows === "object" && !Array.isArray(rows)) {
    rows = (rows as { sections?: unknown }).sections;
  }
  if (!Array.isArray(rows)) return false;
  return rows.some((r) => {
    if (!r || typeof r !== "object") return false;
    const row = r as { gateway?: unknown; label?: unknown; net?: unknown; refund?: unknown };
    const gateway = String(row.gateway ?? row.label ?? "").trim();
    if (gateway !== UNCLASSIFIED_PAYMENT_SECTION_KEY) return false;
    return Number(row.net ?? 0) !== 0 || Number(row.refund ?? 0) !== 0;
  });
}
