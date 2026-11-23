/**
 * POS の注文の詳細（返金・商品券）で、一番上の枠に出す「支払い・返金」の行を作る。
 *
 *   合計
 *   ¥3,325
 *   支払い ・ 現金        ¥3,325
 *   返金 ・ 現金         −¥1,100（赤）
 *
 * 支払方法ごとの額は orderTenderLines（登録画面の「元の支払い」と同じ数え方）を使う。
 * 見せ方だけで、数え方は変えない。
 */
import { orderTenderLines, roundMoney } from "./orderTenderLines.js";

function yen(n) {
  return `¥${roundMoney(n).toLocaleString("ja-JP")}`;
}

/**
 * @param {Record<string, any> | null | undefined} order
 * @returns {{ key: string, label: string, value: string, tone?: string }[]}
 */
export function orderPaymentSummaryLines(order) {
  const tenders = orderTenderLines(order);
  const out = [];
  for (const t of tenders) {
    if (t.paid > 0) out.push({ key: `paid-${t.gateway || t.label}`, label: `支払い ・ ${t.label}`, value: yen(t.paid) });
  }
  let refundedByTender = 0;
  for (const t of tenders) {
    if (t.refunded > 0) {
      refundedByTender += t.refunded;
      out.push({
        key: `refund-${t.gateway || t.label}`,
        label: `返金 ・ ${t.label}`,
        value: `−${yen(t.refunded)}`,
        tone: "critical",
      });
    }
  }
  // 返金の取引が読めない（返金額だけ分かる）ときは、返金の合計を 1 行で出す
  if (refundedByTender === 0) {
    const total = (order?.refunds ?? []).reduce((s, r) => s + (Number(r?.totalRefunded) || 0), 0);
    if (total > 0) out.push({ key: "refund-total", label: "返金", value: `−${yen(total)}`, tone: "critical" });
  }
  return out;
}

/** 注文の状態の印の色（一覧のバッジと同じ考え方: キャンセル=赤、返金=黄） */
export function financialStatusTone(status, cancelledAt) {
  if (cancelledAt) return "critical";
  const s = String(status || "").toUpperCase();
  if (s === "REFUNDED" || s === "PARTIALLY_REFUNDED") return "warning";
  if (s === "PENDING" || s === "AUTHORIZED") return "caution";
  return "neutral";
}
