/**
 * 注文メモから商品券の額面を読むための関数（管理画面のプレビューとサーバーの精算で同じものを使う）
 */
export const DEFAULT_VOUCHER_KEYWORD = "商品券";
/** 読取用正規表現の長さの上限（重い式で集計が止まらないように） */
export const VOUCHER_NOTE_REGEX_MAX_LENGTH = 100;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 読取用正規表現の文字列を確かめる。空なら null（初めの式を使う）。不正・かっこ無しはエラー文 */
export function compileVoucherNoteRegex(src: string | null | undefined): { regex: RegExp | null; error: string | null } {
  const s = String(src ?? "").trim();
  if (!s) return { regex: null, error: null };
  if (s.length > VOUCHER_NOTE_REGEX_MAX_LENGTH) {
    return { regex: null, error: `読取用正規表現は ${VOUCHER_NOTE_REGEX_MAX_LENGTH} 文字までにしてください` };
  }
  let re: RegExp;
  try {
    re = new RegExp(s);
  } catch {
    return { regex: null, error: "読取用正規表現の書き方が正しくありません" };
  }
  // かっこ（金額の部分）が 1 つ以上あるか: 空文字に「何にも当たらない」選択肢を足して数える
  const groups = new RegExp(`${s}|`).exec("")?.length ?? 1;
  if (groups < 2) {
    return { regex: null, error: "読取用正規表現に、金額の部分を ( ) で 1 つ入れてください" };
  }
  return { regex: re, error: null };
}

/** 全角数字・読点を除いて半角化（GAS z2hDigits） */
export function z2hDigits(input: string): string {
  let s = "";
  for (const ch of String(input ?? "")) {
    const code = ch.charCodeAt(0);
    s += code >= 0xff10 && code <= 0xff19 ? String.fromCharCode(code - 0xfee0) : ch;
  }
  return s.replace(/[，、,]/g, "");
}

/** 言葉と式（null なら初めの式）でメモから額面を読む。読めなければ 0 */
export function parseVoucherFaceFromNote(note: string | null | undefined, keyword: string, regex: RegExp | null): number {
  const s = z2hDigits(note ?? "");
  const re = regex ?? new RegExp(`${escapeRegExp(keyword)}\\s*([0-9]+)\\s*(?:円|えん)?`);
  const m = s.match(re);
  const n = m ? Number(z2hDigits(String(m[1] ?? "")).replace(/[^0-9.]/g, "")) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
