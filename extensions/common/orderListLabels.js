/**
 * POS の注文一覧の文字（POS 純正の「すべての注文」と同じ書き方）。
 * 領収書・販売レシート・返金/商品券の一覧で使う。日付は店のタイムゾーンの暦日（サーバーが返す）。
 */
function parseYmd(ymd) {
  const m = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/**
 * 日付だけの見出し（POS 純正の一覧と同じ書き方）。
 * 今日なら「今日」、今年なら「11月20日」、去年より前なら「2025年11月20日」。
 * @param {string} ymd - YYYY-MM-DD（店のタイムゾーンの暦日）
 * @param {string} todayYmd - YYYY-MM-DD（店のタイムゾーンの今日）
 */
export function formatOrderDayLabel(ymd, todayYmd) {
  const d = parseYmd(ymd);
  if (!d) return "";
  if (ymd === todayYmd) return "今日";
  const t = parseYmd(todayYmd);
  if (t && t.y === d.y) return `${d.m}月${d.d}日`;
  return `${d.y}年${d.m}月${d.d}日`;
}

/**
 * 一覧の行の 2 行目（日時）。「今日 18:14」「11月20日 5:30」。
 * 日付が分からないときは時刻だけ。
 * @param {{ localDate?: string, transactionTime?: string }} item
 * @param {string} todayYmd
 */
export function formatOrderDateTimeLabel(item, todayYmd) {
  // 純正と同じく時の 0 は付けない（05:30 → 5:30）
  const time = String(item?.transactionTime ?? "").trim().replace(/^0(\d):/, "$1:");
  const day = formatOrderDayLabel(item?.localDate, todayYmd);
  return [day, time].filter(Boolean).join(" ");
}

/**
 * 一覧の行の 1 行目の左（「#1017 • 山田 太郎」。顧客なしは番号だけ）
 * @param {{ orderName?: string, customerName?: string }} item
 */
export function formatOrderTitle(item) {
  const name = String(item?.orderName ?? "").trim();
  const customer = String(item?.customerName ?? "").trim();
  return customer ? `${name} • ${customer}` : name;
}
