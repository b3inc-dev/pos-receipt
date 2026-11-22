/**
 * 領収書の発行者（ReceiptIssue.createdBy / createdByStaffId）
 *
 * - POS は `shopify.session.currentSession.staffMemberId`（ピン留め中のスタッフ）を送る。
 *   無いときは `userId`（POS にログイン中のユーザー）を送る。
 * - 表示名はサーバーが Admin API の `staffMember` で引けたときだけ保存する。
 *   `staffMember` は `read_users` スコープが要るため、引けないストアでは ID だけを残す。
 * - POS からの自由入力の名前（旧 `createdBy`）は受けない（だれでも任意の名前を書けてしまうため）。
 */

/** POS から来たスタッフ ID を数字だけの文字列にそろえる。おかしな値は null。 */
export function normalizeStaffId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = typeof raw === "number" ? (Number.isSafeInteger(raw) ? String(raw) : "") : String(raw).trim();
  const gid = /^gid:\/\/shopify\/(?:StaffMember|User)\/(\d+)$/.exec(s);
  if (gid) s = gid[1];
  if (!/^\d{1,20}$/.test(s)) return null;
  if (/^0+$/.test(s)) return null;
  return s.replace(/^0+/, "");
}

/** `staffMember` の結果から表示名を作る（名前が空なら null）。 */
export function staffDisplayName(
  staff: { name?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined,
): string | null {
  if (!staff) return null;
  const name =
    staff.name?.trim() ||
    [staff.lastName, staff.firstName].map((v) => v?.trim()).filter(Boolean).join(" ").trim();
  return name ? name.slice(0, 120) : null;
}

/** 管理画面・POS の履歴に出す発行者の文言。 */
export function formatReceiptIssuer(createdBy: string | null | undefined, createdByStaffId: string | null | undefined): string {
  const name = createdBy?.trim();
  if (name) return name;
  const id = createdByStaffId?.trim();
  if (id) return `スタッフ ID ${id}`;
  return "—";
}

export const STAFF_MEMBER_NAME_QUERY = `#graphql
  query ReceiptIssuerStaff($id: ID!) {
    staffMember(id: $id) { id name firstName lastName }
  }
`;

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

/**
 * スタッフ ID から表示名を引く。スコープが無い・見つからない・通信の失敗はすべて null（発行は止めない）。
 */
export async function resolveStaffDisplayName(admin: AdminGraphql, staffId: string | null): Promise<string | null> {
  if (!staffId) return null;
  try {
    const res = await admin.graphql(STAFF_MEMBER_NAME_QUERY, {
      variables: { id: `gid://shopify/StaffMember/${staffId}` },
    });
    const json = (await res.json()) as {
      data?: { staffMember?: { name?: string | null; firstName?: string | null; lastName?: string | null } | null };
    };
    return staffDisplayName(json.data?.staffMember);
  } catch {
    return null;
  }
}
