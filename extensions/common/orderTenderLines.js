/**
 * 注文の支払方法ごとの金額（登録画面に「元の支払い」として出す）
 * - 支払った額: 成功した売上（SALE・CAPTURE）。status が無い古い形は数える
 * - 返金した額: 注文の返金に入っている取引
 * 同じ gateway（大文字小文字は見ない）はまとめる。支払った額の多い順。
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 端数のある通貨でも切り捨てない（1/100 まで残す。円はそのまま） */
export function roundMoney(v) {
  return Math.round(num(v) * 100) / 100;
}

function keyOf(gateway) {
  return String(gateway ?? "").trim().toLowerCase();
}

export function orderTenderLines(order) {
  const lines = new Map();
  const lineFor = (tx) => {
    const gateway = String(tx?.gateway ?? "").trim();
    const key = keyOf(gateway);
    if (!lines.has(key)) {
      lines.set(key, {
        gateway,
        label: String(tx?.displayName || tx?.formattedGateway || gateway || "不明").trim(),
        paid: 0,
        refunded: 0,
      });
    }
    return lines.get(key);
  };
  for (const tx of order?.transactions ?? []) {
    const kind = String(tx?.kind ?? "").toUpperCase();
    if (kind !== "SALE" && kind !== "CAPTURE") continue;
    const status = String(tx?.status ?? "").toUpperCase();
    if (status && status !== "SUCCESS") continue;
    lineFor(tx).paid += num(tx?.amount);
  }
  for (const r of order?.refunds ?? []) {
    for (const rtx of r?.transactions ?? []) {
      lineFor(rtx).refunded += num(rtx?.amount);
    }
  }
  return [...lines.values()]
    .map((l) => ({ ...l, paid: roundMoney(l.paid), refunded: roundMoney(l.refunded) }))
    .filter((l) => l.paid > 0 || l.refunded > 0)
    .sort((a, b) => b.paid - a.paid || b.refunded - a.refunded);
}

/** 特殊返金の「全額反映」で入れる額: 返金した額があればそれ、無ければ支払った額 */
export function fullAmountForRefund(line) {
  if (!line) return 0;
  return line.refunded > 0 ? line.refunded : line.paid;
}

/**
 * 選択肢（支払方法マスタなど）の中から、取引の gateway と同じ名前のものの value。
 * 名前の一部が同じだけのもの（cash と cash_on_delivery など）は当てない。当たらなければ null（呼び出し側は選択を変えない）
 */
export function matchMethodValue(items, gateway) {
  const g = keyOf(gateway);
  if (!g) return null;
  const exact = (items ?? []).find((m) => keyOf(m?.value) === g);
  return exact?.value ?? null;
}
