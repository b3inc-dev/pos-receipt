/**
 * POS 拡張の画面表示用。API・state は YYYY-MM-DD のまま、見た目だけスラッシュ区切りにする。
 */
export function formatYmdSlash(ymd) {
  const s = String(ymd ?? "").trim();
  if (!s || s === "-") return s || "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, "/");
  return s;
}

/**
 * 時刻を日本時間の「HH:MM」で返す（端末の時刻帯によらない）。
 * Intl の timeZone に頼らず、UTC に 9 時間足して出す。
 */
export function formatJstHm(dateOrMs) {
  const ms = dateOrMs instanceof Date ? dateOrMs.getTime() : Number(dateOrMs);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
