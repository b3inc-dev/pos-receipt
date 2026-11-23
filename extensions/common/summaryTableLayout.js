/**
 * POS の精算・売上サマリーの表を「見出しで区切る形」で出すための、表示だけの決まり。
 * 数え方は変えない（受け取った数をどう並べ、どう書くかだけ）。
 * pos-smart-grid の .jsx から使う。試験しやすいよう純粋な関数だけを置く。
 */

/** ¥12,300（null・数でないときは —） */
export function formatYen(n) {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `¥${Math.round(v).toLocaleString("ja-JP")}`;
}

/**
 * 差し引く金額（割引・返金）。0 より大きいときだけ「−¥12,300」と赤で出す。
 * 0 や負のときは符号を付けず、色も付けない。
 * @returns {{ text: string, tone: "critical" | undefined }}
 */
export function formatDeduction(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v <= 0) return { text: formatYen(Number.isFinite(v) ? v : 0), tone: undefined };
  return { text: `−${formatYen(v)}`, tone: "critical" };
}

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** 2026-11-23 → 2026/11/23（日）。形が違うときはそのまま返す */
export function formatYmdWithWeekday(ymd) {
  const s = String(ymd ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s || "—";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return s;
  return `${m[1]}/${m[2]}/${m[3]}（${WEEKDAYS_JA[d.getUTCDay()]}）`;
}

const HERO_LABELS = ["実績", "月実績"];
const BUDGET_LABELS = ["予算", "月予算"];
const RATIO_LABELS = ["予算比", "達成率"];

/**
 * 売上サマリーの行（{label, value, ratio?}[]）を、カードの形に振り分ける。
 * - hero: 大きく出す実績（日次は「実績」、月次は「月実績」。先に見つかった方）
 * - budget: hero と対になる予算（hero が実績なら予算、月実績なら月予算）
 * - ratio: 予算比 / 達成率（hero と対になる方）。ratio（数）があれば達成=success、未達=critical
 * - cells: 残りの行（並び順はそのまま）。3 列に並べる
 * 管理画面で OFF にした項目は元の行に無いので、ここでも出ない。
 */
export function splitMetricItems(items) {
  const list = Array.isArray(items) ? items : [];
  const heroIdx = list.findIndex((r) => HERO_LABELS.includes(r?.label));
  const monthly = heroIdx >= 0 && list[heroIdx].label === "月実績";
  const budgetLabel = monthly ? "月予算" : "予算";
  const ratioLabel = monthly ? "達成率" : "予算比";
  const budgetIdx = list.findIndex((r) => r?.label === budgetLabel);
  const ratioIdx = list.findIndex((r) => r?.label === ratioLabel);
  // hero が無いとき（実績を OFF にしている）は、予算・予算比も表の中に残す
  const pulled = new Set(heroIdx >= 0 ? [heroIdx, budgetIdx, ratioIdx].filter((i) => i >= 0) : []);
  const hero = heroIdx >= 0 ? list[heroIdx] : null;
  const budget = heroIdx >= 0 && budgetIdx >= 0 ? list[budgetIdx] : null;
  let ratio = null;
  if (heroIdx >= 0 && ratioIdx >= 0) {
    const r = list[ratioIdx];
    const num = Number(r.ratio);
    ratio = {
      label: r.label,
      value: r.value,
      tone: Number.isFinite(num) ? (num >= 1 ? "success" : "critical") : "neutral",
    };
  }
  const cells = list.filter((_, i) => !pulled.has(i));
  return { hero, budget, ratio, cells };
}

/** [a,b,c,d] → [[a,b,c],[d]] */
export function chunkRows(items, size = 3) {
  const out = [];
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export { HERO_LABELS, BUDGET_LABELS, RATIO_LABELS };
