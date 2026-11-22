/**
 * 領収書の発行者（ReceiptIssue.createdBy / createdByStaffId）
 *
 * T さんの決定（2026-11-23 4:20）: 発行者は「領収書を発行した人 1 人」。販売担当（帰属スタッフ）とは別に記録する。
 *
 * - POS は `shopify.session.currentSession.staffMemberId`（いま POS にピン留めされているスタッフ）を送る。
 *   無いときは `userId`（POS にログインしているユーザー）。セッショントークンはログイン中のユーザーなので使わない。
 * - サーバーは数字だけにそろえて createdByStaffId に保存する。POS からの自由入力の名前は受けない。
 * - 名前は管理画面「スタッフ名」の登録（AppSetting `staff_display_names_v1`・販売担当の作業 #84 と同じキー）から引く。
 *   登録が無ければ「スタッフ ID n」。`staffMember` を Admin API で読むには read_users が要るので読まない。
 */

/** POS から来たスタッフ ID を数字だけの文字列にそろえる。おかしな値は null。 */
export function normalizeStaffId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s =
    typeof raw === "number"
      ? Number.isSafeInteger(raw) && raw > 0
        ? String(raw)
        : ""
      : typeof raw === "string"
        ? raw.trim()
        : "";
  const gid = /^gid:\/\/shopify\/(?:StaffMember|User)\/(\d+)$/.exec(s);
  if (gid) s = gid[1];
  if (!/^\d{1,20}$/.test(s)) return null;
  if (/^0+$/.test(s)) return null;
  return s.replace(/^0+/, "");
}

/** 管理画面「スタッフ名」の保存キー（#84 の STAFF_DISPLAY_NAMES_KEY と同じ。#84 が入ったらそちらを使う） */
export const STAFF_DISPLAY_NAMES_SETTING_KEY = "staff_display_names_v1";

/** 「スタッフ名」の保存値 `{ names: { [staffId]: name } }` から ID → 名前を取り出す。形が違えば空。 */
export function parseStaffNameMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const names = (raw as { names?: unknown } | null)?.names;
  if (!names || typeof names !== "object" || Array.isArray(names)) return out;
  for (const [k, v] of Object.entries(names as Record<string, unknown>)) {
    const id = normalizeStaffId(k);
    if (!id || typeof v !== "string") continue;
    const name = v.replace(/\s+/g, " ").trim().slice(0, 60);
    if (name) out[id] = name;
  }
  return out;
}

/** 発行した時点の名前（登録があれば）。無ければ null。 */
export function issuerNameAtIssue(staffId: string | null, names: Record<string, string>): string | null {
  return staffId ? names[staffId] ?? null : null;
}

/**
 * 管理画面・POS の履歴に出す発行者の文言。
 * いまの登録名 → 発行時に保存した名前 → 「スタッフ ID n」 → 「—」。
 */
export function formatReceiptIssuer(
  createdBy: string | null | undefined,
  createdByStaffId: string | null | undefined,
  currentNames: Record<string, string> = {},
): string {
  const id = normalizeStaffId(createdByStaffId);
  const current = id ? currentNames[id] : undefined;
  if (current) return current;
  const saved = createdBy?.trim();
  if (saved) return saved;
  if (id) return `スタッフ ID ${id}`;
  return "—";
}
