/**
 * 領収書の「再発行として記録する」を自動で選ぶ（T さんの決定 2026-11-24）
 *
 * - 一度でも領収書を発行した注文を選んだら、初めからオンにする。店の人は手で外せる
 *   （宛名を分けてもう 1 枚出すときなど）。
 * - 発行したかどうかは、この店舗（ショップ）の発行の記録（ReceiptIssue）を注文で引いて見る。
 *   発行の記録は消さない作りなので、記録があれば「発行したことがある」とする。
 * - お金の数字（売上・返金・精算）には関わらない。
 *
 * 画面（ReceiptModal.jsx）と試験（app/utils/receiptReissue.test.ts）から使う。
 */

/** "YYYY-MM-DD" を「11/20」（年が違えば「2025/11/20」）、今日なら「今日」にする */
export function issuedDayLabel(localDate, todayLocalDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDate ?? ""));
  if (!m) return "";
  if (todayLocalDate && localDate === todayLocalDate) return "今日";
  const md = `${Number(m[2])}/${Number(m[3])}`;
  const ty = /^(\d{4})-/.exec(String(todayLocalDate ?? ""))?.[1];
  return ty && ty !== m[1] ? `${m[1]}/${md}` : md;
}

/**
 * 発行履歴（GET /api/receipts/history?orderId=…）の items から、この注文の発行の様子をまとめる。
 * items は新しい順（サーバーの並び）。順が違っても createdAt でいちばん新しいものを使う。
 *
 * @returns {{ issuedBefore: boolean, count: number, lastLabel: string, notice: string }}
 */
export function summarizePriorReceipts(items, todayLocalDate) {
  const list = (Array.isArray(items) ? items : []).filter((r) => r && r.id);
  if (list.length === 0) {
    return { issuedBefore: false, count: 0, lastLabel: "", notice: "" };
  }
  const last = list.reduce((a, b) =>
    String(b.createdAt ?? "") > String(a.createdAt ?? "") ? b : a,
  );
  const day = issuedDayLabel(last.localDate, todayLocalDate);
  const time = /^\d{2}:\d{2}$/.test(String(last.transactionTime ?? "")) ? last.transactionTime : "";
  const lastLabel = [day, time].filter(Boolean).join(" ");
  const notice =
    list.length > 1
      ? `この注文は領収書を ${list.length} 回発行しています（いちばん新しいのは ${lastLabel || "前"}）。`
      : `この注文は${lastLabel ? ` ${lastLabel} に` : "前に"}領収書を発行しています。`;
  return { issuedBefore: true, count: list.length, lastLabel, notice };
}

/**
 * 「再発行として記録する」の下に出す説明。
 * - 発行したことがある注文: 自動でオンにした理由と、外すとき
 * - 無い注文: 今までと同じ説明
 */
export function reissueHelpText(summary, isReissue) {
  if (summary?.issuedBefore) {
    return isReissue
      ? "そのため再発行にしています。宛名を分けて別の領収書を出すときは外してください。"
      : "再発行を外しています。発行した人と時刻は発行履歴に残ります。";
  }
  return "前に出した領収書を出し直すときだけ選びます。領収書に【再発行】と入ります。";
}
