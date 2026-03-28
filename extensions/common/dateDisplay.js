/**
 * POS 拡張の画面表示用。API・state は YYYY-MM-DD のまま、見た目だけスラッシュ区切りにする。
 */
export function formatYmdSlash(ymd) {
  const s = String(ymd ?? "").trim();
  if (!s || s === "-") return s || "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, "/");
  return s;
}
