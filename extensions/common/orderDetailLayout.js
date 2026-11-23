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

/**
 * 注文の状態の印の色。一覧のバッジ（orderDisplayUtils の refundBadge）と同じ:
 * キャンセル=赤、一部返金=黄（caution）、返金済=橙（warning）
 */
export function financialStatusTone(status, cancelledAt) {
  if (cancelledAt) return "critical";
  const s = String(status || "").toUpperCase();
  if (s === "PARTIALLY_REFUNDED") return "caution";
  if (s === "REFUNDED") return "warning";
  return "neutral";
}

/**
 * 顧客の欄に出す字。
 * 名前の許可が無いアプリでは名前なしで読み直すので、顧客がいても名前が無いことがある。
 * そのときは「顧客なし」と誤って出さず「顧客あり（名前は表示できません）」にする。
 */
export function customerLabel(order) {
  const c = order?.customer;
  const name = String(c?.displayName ?? "").trim();
  if (name) return name;
  if (c && c.id) return "顧客あり（名前は表示できません）";
  return "顧客なし";
}

/**
 * 調整履歴の 1 件の状態の印（一覧のバッジと同じ考え方の色）。
 * Shopify 返金の状態と、管理者の承認の状態。
 * @param {Record<string, any>} event
 * @returns {{ key: string, label: string, tone: string }[]}
 */
export function adjustmentBadges(event) {
  const out = [];
  // 純正の返金の付け替え: Shopify の返金は純正の返金（このアプリでは返金していない）
  if (event?.refundSource === "native") {
    out.push({ key: "refund", label: "純正返金の付け替え", tone: "success" });
  } else switch (event?.shopifyRefundStatus) {
    case "pending":
      out.push({ key: "refund", label: "返金処理中", tone: "critical" });
      break;
    case "success":
      out.push({ key: "refund", label: "返金済", tone: "success" });
      break;
    case "failed":
      out.push({ key: "refund", label: "返金失敗", tone: "critical" });
      break;
    case "skipped":
      // 商品券釣銭調整は Shopify で返金しないのがいつもなので出さない（現金で釣銭を返したのに「記録のみ」と読めて紛らわしい。T 2026-11-24）
      if (event?.eventType !== "voucher_change_adjustment") {
        out.push({ key: "refund", label: "記録のみ", tone: "neutral" });
      }
      break;
    default:
      break;
  }
  switch (event?.approvalStatus) {
    case "pending":
      out.push({ key: "approval", label: "承認待ち", tone: "caution" });
      break;
    case "approved":
      out.push({ key: "approval", label: "承認済", tone: "success" });
      break;
    case "rejected":
      out.push({ key: "approval", label: "却下", tone: "critical" });
      break;
    default:
      break;
  }
  return out;
}

function shortDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ""));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(isoDate ?? "");
}

/** 元の手段と実際の手段が同じか（分割の残額の行など、手段が変わらない調整） */
export function sameRefundMethod(event) {
  const k = (v) => String(v ?? "").trim().toLowerCase();
  const from = k(event?.originalPaymentMethod);
  const to = k(event?.actualRefundMethod);
  if (from && to && from === to) return true;
  const fl = k(event?.originalPaymentLabel);
  return fl !== "" && fl === k(event?.actualRefundLabel);
}

/**
 * 調整履歴の 1 件の灰色の小さい字の行（手段・内訳・いつの精算・登録日時）。
 * @param {Record<string, any>} event
 * @returns {string[]}
 */
export function adjustmentSubLines(event) {
  const lines = [];
  if (event?.eventType === "voucher_change_adjustment") {
    lines.push(
      `額面 ${yen(event.voucherFaceValue)} ・ 商品券で払った額 ${yen(event.voucherAppliedAmount)} ・ 釣銭 ${yen(event.voucherChangeAmount)}`,
    );
  }
  const from = event?.originalPaymentMethod ? event.originalPaymentLabel || event.originalPaymentMethod : "";
  const to = event?.actualRefundMethod ? event.actualRefundLabel || event.actualRefundMethod : "";
  if (from && to && sameRefundMethod(event)) lines.push(`${to}のまま（手段の変更なし）`);
  else if (from && to) lines.push(`${from} → ${to} で返金`);
  else if (from) lines.push(`元の支払い ${from}`);
  else if (to) lines.push(`${to} で返金`);
  const when = [
    event?.countDate ? `${shortDate(event.countDate)} の精算` : "",
    event?.createdAtLabel ? `登録 ${event.createdAtLabel}${event.replacesEventId ? "（変更あり）" : ""}` : "",
  ].filter(Boolean);
  if (when.length) lines.push(when.join(" ・ "));
  if (event?.note) lines.push(`メモ ${event.note}`);
  return lines;
}

/** 調整履歴の種類の名前。返金の付け替え 2 種は、手段を変えても名前がずれないよう 1 つの名前にする */
export function adjustmentKindLabel(event) {
  switch (event?.eventType) {
    case "cash_refund":
    case "payment_method_override":
      // 純正の返金の付け替えも同じ名前。違いはバッジ「純正返金の付け替え」で分かる
      return "返金の手段の変更";
    case "receipt_cash_adjustment":
      return "レシート現金調整";
    case "voucher_change_adjustment":
      return "商品券調整";
    default:
      return String(event?.eventType ?? "");
  }
}

/**
 * 一番上の「返金 ・ 現金」の下に出す、付け替えの内訳（灰色の小さい字）。
 * 上の行は Shopify の返金の取引のまま。精算・売上サマリーはこの付け替えのあとの手段で数える。
 *   うち ¥500 はクレジットカードで返金（付け替え）
 * @param {Record<string, any>[]} events
 * @returns {{ key: string, text: string }[]}
 */
export function reassignmentSummaryLines(events) {
  const byTo = new Map();
  for (const e of events ?? []) {
    if (e?.status && e.status !== "active") continue;
    if (e?.eventType !== "cash_refund" && e?.eventType !== "payment_method_override") continue;
    if (String(e?.approvalStatus ?? "") === "rejected") continue;
    const from = String(e?.originalPaymentMethod ?? "").trim().toLowerCase();
    const to = String(e?.actualRefundMethod ?? "").trim();
    if (!to || to.toLowerCase() === from) continue;
    const fromLabel = e.originalPaymentLabel || e.originalPaymentMethod || "";
    const toLabel = e.actualRefundLabel || to;
    const k = `${from}→${to.toLowerCase()}`;
    const cur = byTo.get(k) ?? { fromLabel, toLabel, amount: 0, pending: false };
    cur.amount = roundMoney(cur.amount + (Number(e.amount) || 0));
    if (String(e?.approvalStatus ?? "") === "pending") cur.pending = true;
    byTo.set(k, cur);
  }
  return [...byTo.entries()]
    .filter(([, v]) => v.amount > 0)
    .map(([k, v]) => ({
      key: `reassign-${k}`,
      text: `うち ${yen(v.amount)} は${v.toLabel}で返金（${v.fromLabel ? `${v.fromLabel}から` : ""}付け替え${v.pending ? "・承認待ち" : ""}）`,
    }));
}
