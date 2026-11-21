/**
 * 会員証に出すランク・ポイントの値を、Shop Point の顧客メタフィールド（shop_point.*）から優先して読む。
 * Shop Point の値がまだ無い会員（切替前・照合前）だけ、旧VIPの vip.* を使う（移行期間の併用）。
 *
 * - shop_point.rank_name / points_approved / rank_decision_purchase_price は vip.* の同名キーに相当
 * - 失効は shop_point.upcoming_expirations（[{ expiresOn: "YYYY-MM-DD", points }]）のいちばん早い分を、
 *   vip.expiry_date / vip.expiring_points に相当する値として出す。Shop Point の一覧があれば空でも旧VIPへ戻さない
 */

type Field = { value?: string | null } | null | undefined;

export type MemberMetafieldNode = {
  spRankName?: Field;
  spPointsApproved?: Field;
  spRankDecisionPurchasePrice?: Field;
  spUpcomingExpirations?: Field;
  vipRankName?: Field;
  vipPointsApproved?: Field;
  vipRankDecisionPurchasePrice?: Field;
  vipExpiryDate?: Field;
  vipExpiringPoints?: Field;
};

export type MemberMetafieldValues = {
  rankName?: string;
  pointsApproved?: string;
  rankDecisionPurchasePrice?: number;
  expiryDate?: string;
  expiringPoints?: string;
};

function text(field: Field): string | undefined {
  const raw = field?.value;
  return typeof raw === "string" ? raw.trim() || undefined : undefined;
}

function nonNegative(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Shop Point の失効予定一覧。読めない値は null（旧VIPへ戻す）、空の一覧は失効なし。 */
function earliestExpiration(field: Field): { expiryDate?: string; expiringPoints?: string } | null {
  const raw = text(field);
  if (raw == null) return null;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  let first: { expiresOn: string; points: number } | null = null;
  for (const item of list) {
    const expiresOn = (item as { expiresOn?: unknown })?.expiresOn;
    const points = (item as { points?: unknown })?.points;
    if (typeof expiresOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) continue;
    if (typeof points !== "number" || !Number.isInteger(points) || points <= 0) continue;
    if (!first || expiresOn < first.expiresOn) first = { expiresOn, points };
    else if (expiresOn === first.expiresOn) first = { expiresOn, points: first.points + points };
  }
  return first ? { expiryDate: first.expiresOn, expiringPoints: String(first.points) } : {};
}

export function memberMetafieldValues(node: MemberMetafieldNode | null | undefined): MemberMetafieldValues {
  const rankName = text(node?.spRankName) ?? text(node?.vipRankName);
  const pointsApproved = text(node?.spPointsApproved) ?? text(node?.vipPointsApproved);
  const rankDecisionPurchasePrice =
    nonNegative(text(node?.spRankDecisionPurchasePrice)) ?? nonNegative(text(node?.vipRankDecisionPurchasePrice));
  const shopPointExpiry = earliestExpiration(node?.spUpcomingExpirations);
  const expiry = shopPointExpiry ?? {
    expiryDate: text(node?.vipExpiryDate),
    expiringPoints: text(node?.vipExpiringPoints),
  };
  return { rankName, pointsApproved, rankDecisionPurchasePrice, expiryDate: expiry.expiryDate, expiringPoints: expiry.expiringPoints };
}
