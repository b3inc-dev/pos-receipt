/**
 * 領収書の「再発行を外して発行した」記録（T さんの決定 2026-11-24）
 *
 * POS は、前に領収書を発行した注文を選ぶと「再発行として記録する」を初めからオンにする（店の人が外せる）。
 * 外して発行したものは、だれが・いつを後で確かめられるようにする。
 *
 * 新しい列は足さない: 発行の記録（ReceiptIssue）には、発行した人（createdByStaffId・createdBy）と
 * 時刻（createdAt）がもうある。「同じ注文に、それより前の発行がある のに isReissue が false」なら
 * 外して発行したもの、と記録から読む（記録は消さない作りなので、あとから変わらない）。
 * お金の数字には関わらない。
 */

export type ReceiptIssueStamp = {
  id: string;
  orderId: string;
  isReissue: boolean;
  createdAt: Date | string;
};

function ms(v: Date | string): number {
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

/**
 * rows のうち「前に同じ注文の発行があるのに、再発行にせずに発行した」ものの id。
 * earlier には、同じ注文の発行の記録（rows を含めてよい）を渡す。
 */
export function receiptIdsIssuedWithoutReissue(
  rows: ReceiptIssueStamp[],
  earlier: Pick<ReceiptIssueStamp, "id" | "orderId" | "createdAt">[],
): Set<string> {
  const firstByOrder = new Map<string, { t: number; id: string }>();
  for (const e of earlier) {
    const t = ms(e.createdAt);
    if (!e.orderId || !Number.isFinite(t)) continue;
    const cur = firstByOrder.get(e.orderId);
    // 同じ時刻なら id の小さいほうを先とする（並びを決めるため）
    if (!cur || t < cur.t || (t === cur.t && e.id < cur.id)) firstByOrder.set(e.orderId, { t, id: e.id });
  }
  const out = new Set<string>();
  for (const r of rows) {
    if (r.isReissue) continue;
    const first = firstByOrder.get(r.orderId);
    if (!first || first.id === r.id) continue;
    const t = ms(r.createdAt);
    if (Number.isFinite(t) && (first.t < t || (first.t === t && first.id < r.id))) out.add(r.id);
  }
  return out;
}
