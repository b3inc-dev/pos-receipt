/**
 * ほかの店舗で売って、この店舗で返品した注文を選ぶ（POS の返金の一覧用・純関数）。
 * 返金の取引の店がこの店舗で、返金した時刻が日の範囲に入る返金が 1 つでもある注文。
 */
export type RefundedAtLocationOrder = {
  id: string;
  retailLocation?: { id?: string | null } | null;
  refunds?: Array<{
    createdAt?: string | null;
    transactions?: { nodes?: Array<{ kind?: string | null; location?: { id?: string | null } | null }> } | null;
  }> | null;
  [k: string]: unknown;
};

function locRaw(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  const m = s.match(/(\d+)$/);
  return m ? m[1] : "";
}

export function pickOrdersRefundedAtLocation(
  orders: RefundedAtLocationOrder[],
  locationIdRaw: string,
  startUtcIso: string,
  endUtcIso: string,
): RefundedAtLocationOrder[] {
  const loc = locRaw(locationIdRaw);
  if (!loc) return [];
  const start = new Date(startUtcIso).getTime();
  const end = new Date(endUtcIso).getTime();
  const out: RefundedAtLocationOrder[] = [];
  const seen = new Set<string>();
  for (const o of orders ?? []) {
    if (!o?.id || seen.has(o.id)) continue;
    // この店舗で売った注文は、いつもの一覧に入る
    if (locRaw(o.retailLocation?.id) === loc) continue;
    const hit = (o.refunds ?? []).some((r) => {
      const t = new Date(String(r?.createdAt ?? "")).getTime();
      if (!Number.isFinite(t) || t < start || t > end) return false;
      return (r?.transactions?.nodes ?? []).some(
        (tx) => String(tx?.kind ?? "").toUpperCase() === "REFUND" && locRaw(tx?.location?.id) === loc,
      );
    });
    if (hit) {
      seen.add(o.id);
      out.push(o);
    }
  }
  return out;
}
