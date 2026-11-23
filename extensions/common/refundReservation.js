/**
 * 返金の予約（POS の画面の計算と文言）。サーバーは app/services/refundReservationPure.ts
 */
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * 予約の行。rows: [{ amount: string, method: string }]（最後の行は残り＝返金額から自動なので金額を入れない）
 * 戻り: { ok, error, rows: [{ actualRefundMethod, amount|null }] }
 */
export function reservationRowsFromInput(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { ok: false, error: "返金方法を選んでください", rows: [] };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] ?? {};
    if (!String(r.method ?? "").trim()) return { ok: false, error: `${i + 1} 行目の返金方法を選んでください`, rows: [] };
    const isLast = i === list.length - 1;
    const amount = isLast ? null : money(r.amount);
    if (!isLast && !(amount > 0)) return { ok: false, error: `${i + 1} 行目の金額を 0 より大きく入れてください`, rows: [] };
    out.push({ actualRefundMethod: String(r.method), amount });
  }
  return { ok: true, error: "", rows: out };
}

/**
 * 返金する金額（純正で返金する見込みの額）。要る。分けた行（最後以外）の合計はこれより小さく。
 * 純正の返金額がこれと違うと、自動では付け替えずに「要確認」にする（T 2026-11-23）
 */
export function reservationExpectedAmountFromInput(input, rows) {
  const expected = money(input);
  if (!(expected > 0)) return { ok: false, error: "返金する金額を入れてください", amount: 0 };
  const fixed = (Array.isArray(rows) ? rows : []).slice(0, -1).reduce((s, r) => s + money(r?.amount), 0);
  if (!(money(fixed) < expected)) {
    return {
      ok: false,
      error: `分けた金額の合計（¥${money(fixed).toLocaleString()}）を、返金する金額（¥${expected.toLocaleString()}）より小さくしてください`,
      amount: 0,
    };
  }
  return { ok: true, error: "", amount: expected };
}

const STATUS_LABEL = {
  pending: "予約中",
  applied: "返金に使いました",
  needs_review: "要確認",
  cancelled: "やめた予約",
  expired: "期限切れ",
};

export function reservationStatusLabel(status) {
  return STATUS_LABEL[status] ?? "";
}

export function reservationStatusTone(status) {
  if (status === "pending") return "info";
  if (status === "applied") return "success";
  if (status === "needs_review") return "warning";
  return "neutral";
}

/** 予約の行の文: 「現金 ¥1,000」「施設ポイント 残り」 */
export function reservationRowText(row) {
  const label = row?.actualRefundLabel || row?.actualRefundMethod || "-";
  return row?.amount == null ? `${label} 残り` : `${label} ¥${money(row.amount).toLocaleString()}`;
}
