/**
 * POS 純正の返金の付け替え（POS の画面の計算）。
 * - 初めは純正の返金額のまま、手段だけ選ぶ（T の決定 2026-11-23）
 * - 「分割」: 金額＋手段の行と、残額＋手段の行。「追加」で何行でも。最後の行は残額が自動で入る
 * 合計は必ず返金の残りと同じになる。サーバーでも残りを超えないかを確かめる。
 */

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** 付け替えできる行（残りがある）か */
export function canReassign(line) {
  return money(line?.remaining) > 0;
}

/** 純正の返金の行のラベル（店の人向け）: 「11/23 14:05 施設ポイント ¥3,000」 */
export function nativeRefundLineLabel(line) {
  const parts = [line?.createdAtLabel, line?.label || line?.gateway, `¥${money(line?.amount).toLocaleString()}`];
  return parts.filter(Boolean).join(" ");
}

/** 純正の返金の行の状態の文: 付け替え済み・残り */
export function nativeRefundLineStatus(line) {
  const remaining = money(line?.remaining);
  const reassigned = money(line?.reassigned);
  if (remaining <= 0) return "付け替え済み";
  if (reassigned > 0) return `一部付け替え済み（残り ¥${remaining.toLocaleString()}）`;
  return "";
}

/**
 * 分割の行の金額。rows: [{ amount: string, method: string }]（最後の行の amount は使わない）。
 * 戻り: { amounts: number[], lastAmount: number, ok: boolean, error: string }
 */
export function splitAmounts(total, rows) {
  const t = money(total);
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= 1) {
    return { amounts: [t], lastAmount: t, ok: t > 0, error: t > 0 ? "" : "付け替えられる金額がありません" };
  }
  const head = list.slice(0, -1).map((r) => money(r?.amount));
  if (head.some((a) => !(a > 0))) {
    return { amounts: [], lastAmount: 0, ok: false, error: "分けた金額を 0 より大きく入れてください" };
  }
  const lastAmount = money(t - head.reduce((s, a) => s + a, 0));
  if (!(lastAmount > 0)) {
    return {
      amounts: [],
      lastAmount,
      ok: false,
      error: `分けた金額の合計が返金額（¥${t.toLocaleString()}）以上です。最後の行に残る額が要ります`,
    };
  }
  return { amounts: [...head, lastAmount], lastAmount, ok: true, error: "" };
}

/** 行ごとの手段がそろっているか */
export function allRowsHaveMethod(rows, selectable) {
  const values = new Set((selectable ?? []).map((m) => m.value));
  return (rows ?? []).every((r) => r?.method && values.has(r.method));
}
