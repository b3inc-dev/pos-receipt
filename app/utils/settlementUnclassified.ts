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
  if (!Array.isArray(rows)) return false;
  return rows.some((r) => {
    if (!r || typeof r !== "object") return false;
    const row = r as { gateway?: unknown; net?: unknown; refund?: unknown };
    if (String(row.gateway ?? "").trim() !== UNCLASSIFIED_PAYMENT_SECTION_KEY) return false;
    return Number(row.net ?? 0) !== 0 || Number(row.refund ?? 0) !== 0;
  });
}
