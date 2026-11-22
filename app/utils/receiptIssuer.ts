/**
 * 領収書の発行者（ReceiptIssue.createdBy / createdByStaffId）
 *
 * T さんの決定（2026-11-23）: 発行者は注文の「帰属スタッフ」。POS でピン留め中・ログイン中のスタッフではない。
 *
 * - 帰属スタッフは販売の帰属スタッフ対応の共通部品から取る
 *   （`getOrderAttributedStaff`・orders/updated の通知の attributed_staffs を記録したもの）。
 * - 何人か付いているときは明細の順に全員。ID は `,` 区切りで createdByStaffId、
 *   発行した時点で名前が分かった人だけ `・` 区切りで createdBy に残す。
 * - 履歴では、いまの「スタッフ名」の登録を先に使う（あとから名前を登録しても出る）。
 * - POS から送られる名前・ID は使わない。
 */
import { cleanStaffName, formatAttributedStaffLabel, normalizeStaffId, type AttributedStaff } from "./attributedStaff";

/** 帰属スタッフの一覧を、ReceiptIssue に保存する形にする。 */
export function receiptIssuerFromAttributedStaff(
  staffs: Pick<AttributedStaff, "staffId" | "name">[] | null | undefined,
): { createdBy: string | null; createdByStaffId: string | null } {
  const ids: string[] = [];
  const names: string[] = [];
  for (const s of staffs ?? []) {
    const id = normalizeStaffId(s.staffId);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    const name = cleanStaffName(s.name);
    if (name) names.push(name);
  }
  return {
    createdByStaffId: ids.length ? ids.join(",").slice(0, 500) : null,
    createdBy: names.length ? names.join("・").slice(0, 300) : null,
  };
}

/**
 * 管理画面・POS の履歴に出す発行者の文言。
 * ID があれば ID ごとに「いまの登録名 → スタッフ ID n」。ID が無い古い行は保存した名前、それも無ければ「—」。
 * 登録名が無く発行時の名前だけある行（read_users の店など）は、保存した名前を使う。
 */
export function formatReceiptIssuer(
  createdBy: string | null | undefined,
  createdByStaffId: string | null | undefined,
  currentNames: Record<string, string | null | undefined> = {},
): string {
  const ids = (createdByStaffId ?? "").split(",").map((v) => normalizeStaffId(v)).filter((v): v is string => !!v);
  const saved = cleanStaffName(createdBy);
  if (ids.length) {
    const anyCurrent = ids.some((id) => cleanStaffName(currentNames[id]));
    if (!anyCurrent && saved) return saved;
    return ids.map((id) => formatAttributedStaffLabel({ staffId: id, name: cleanStaffName(currentNames[id]) })).join("・");
  }
  return saved ?? "—";
}
