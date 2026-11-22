/**
 * 領収書の発行者（ReceiptIssue.createdBy / createdByStaffId）
 *
 * T さんの決定（2026-11-22）: 発行者は注文の「帰属スタッフ」（POS で明細に付けたスタッフ）。
 * POS でピン留め中・ログイン中のスタッフではない。
 *
 * - 帰属スタッフは注文の明細 `lineItems.staffMember` から取る（注文詳細 API `orderDetail.server.ts` と同じ取り方）。
 * - 明細ごとに違うスタッフが付いているときは、明細の順に重複を除いて全員を並べる。
 *   ID は `,` 区切り、名前は `・` 区切りで保存する。
 * - 帰属スタッフが 1 人もいない注文は null（履歴は「—」）。
 * - POS から送られる名前・ID は使わない（サーバーが注文から引くので、だれでも書き換えられる値にならない）。
 */

export type AttributedStaffMember = {
  id?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
} | null | undefined;

/** 明細の staffMember の GID（または数字）を数字だけにそろえる。おかしな値は null。 */
export function normalizeStaffId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = typeof raw === "number" ? (Number.isSafeInteger(raw) ? String(raw) : "") : String(raw).trim();
  const gid = /^gid:\/\/shopify\/(?:StaffMember|User)\/(\d+)$/.exec(s);
  if (gid) s = gid[1];
  if (!/^\d{1,20}$/.test(s)) return null;
  if (/^0+$/.test(s)) return null;
  return s.replace(/^0+/, "");
}

/** staffMember から表示名を作る。`orderDetail.server.ts` の staffMemberName と同じ順（name → 名 姓）。 */
export function staffDisplayName(staff: AttributedStaffMember): string | null {
  if (!staff) return null;
  const name =
    staff.name?.trim() ||
    [staff.firstName, staff.lastName].map((v) => v?.trim()).filter(Boolean).join(" ").trim();
  return name ? name.slice(0, 120) : null;
}

/**
 * 注文の明細から帰属スタッフをまとめる。
 * 戻り値の staffIds は `,` 区切り、names は `・` 区切り（名前が引けないスタッフは名前に入れない）。
 */
export function attributedStaffFromLineItems(
  lineItems: Array<{ staffMember?: AttributedStaffMember }> | null | undefined,
): { staffIds: string | null; names: string | null } {
  const ids: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const li of lineItems ?? []) {
    const staff = li?.staffMember;
    if (!staff) continue;
    const id = normalizeStaffId(staff.id);
    const name = staffDisplayName(staff);
    const key = id ?? (name ? `name:${name}` : null);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (id) ids.push(id);
    if (name) names.push(name);
  }
  return {
    staffIds: ids.length ? ids.join(",").slice(0, 500) : null,
    names: names.length ? names.join("・").slice(0, 300) : null,
  };
}

/** 管理画面・POS の履歴に出す発行者の文言（名前 → スタッフ ID → —）。 */
export function formatReceiptIssuer(createdBy: string | null | undefined, createdByStaffId: string | null | undefined): string {
  const name = createdBy?.trim();
  if (name) return name;
  const ids = createdByStaffId?.split(",").map((v) => v.trim()).filter(Boolean) ?? [];
  if (ids.length) return ids.map((id) => `スタッフ ID ${id}`).join("・");
  return "—";
}
