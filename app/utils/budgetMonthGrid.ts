/**
 * 予算の日別一覧（店舗ごと・月ごと）で使う純関数。
 * 日付は店舗の暦日（YYYY-MM-DD の文字列）として扱い、端末やサーバーの時差で日がずれないよう UTC の暦で曜日を出す。
 */

export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 予算 1 日分の上限（DB は Decimal(18,2)。入力の誤り（桁の打ち間違い）を止めるため 1 兆円未満にする） */
export const MAX_DAILY_BUDGET = 999_999_999_999;

export type MonthDay = { date: string; day: number; weekday: number; weekdayLabel: string };

/** "YYYY-MM" が正しい月か */
export function isMonthKey(value: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

/** 月の 1 日〜月末を並べる */
export function monthDays(monthKey: string): MonthDay[] {
  if (!isMonthKey(monthKey)) return [];
  const [y, m] = monthKey.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: MonthDay[] = [];
  for (let day = 1; day <= last; day++) {
    const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    days.push({
      date: `${monthKey}-${String(day).padStart(2, "0")}`,
      day,
      weekday,
      weekdayLabel: WEEKDAY_LABELS[weekday],
    });
  }
  return days;
}

/** "YYYY-MM" に月を足す（負も可） */
export function addMonths(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 選べる月（基準の月の前 12 か月〜後 12 か月） */
export function monthChoices(baseMonth: string, before = 12, after = 12): string[] {
  const out: string[] = [];
  for (let i = -before; i <= after; i++) out.push(addMonths(baseMonth, i));
  return out;
}

/** "2026-11" → "2026年11月" */
export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return `${y}年${m}月`;
}

export type ParsedAmount = { ok: true; value: number | null } | { ok: false; reason: string };

/**
 * 入力欄の文字を金額にする。空欄は「予算なし」（null）。
 * 「¥」「,」「円」・空白・全角数字は受け付ける。小数は 2 桁まで（DB と同じ）。負の数・上限超えは誤り。
 */
export function parseBudgetInput(raw: string): ParsedAmount {
  const halfWidth = String(raw ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，]/g, ",")
    .replace(/[．]/g, ".")
    .replace(/[￥]/g, "¥");
  const cleaned = halfWidth.replace(/[¥,\s　円]/g, "");
  if (cleaned === "") return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false, reason: "0 以上の金額を数字で入力してください" };
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value > MAX_DAILY_BUDGET) {
    return { ok: false, reason: "金額が大きすぎます" };
  }
  return { ok: true, value };
}

export type BudgetChange = {
  date: string;
  before: number | null;
  after: number | null;
  kind: "add" | "update" | "remove";
};

/**
 * 保存済みの値と入力を比べ、変わった日だけを返す。入力が誤りの日は errors に入れ、changes には入れない。
 * saved: date → 金額（保存済み）。inputs: date → 入力欄の文字。
 */
export function diffBudgetMonth(
  days: string[],
  saved: Record<string, number | null | undefined>,
  inputs: Record<string, string | undefined>,
): { changes: BudgetChange[]; errors: { date: string; reason: string }[] } {
  const changes: BudgetChange[] = [];
  const errors: { date: string; reason: string }[] = [];
  for (const date of days) {
    const before = saved[date] ?? null;
    const raw = inputs[date];
    if (raw === undefined) continue;
    const parsed = parseBudgetInput(raw);
    if (!parsed.ok) {
      errors.push({ date, reason: parsed.reason });
      continue;
    }
    const after = parsed.value;
    if (before === after) continue;
    changes.push({
      date,
      before,
      after,
      kind: after === null ? "remove" : before === null ? "add" : "update",
    });
  }
  return { changes, errors };
}

/** 月の合計（予算なしの日は 0 として足す）と、予算が入っている日数 */
export function sumBudgetMonth(values: (number | null | undefined)[]): { total: number; filledDays: number } {
  let total = 0;
  let filledDays = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    total += v;
    filledDays++;
  }
  return { total, filledDays };
}

/** 保存済みの金額を入力欄の文字にする（予算なしは空欄。読みやすいよう 3 桁ごとにカンマ） */
export function budgetToInput(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * 人が書いた日付を YYYY-MM-DD にする（2026/11/24・2026-11-24・2026/1/5 など）。読めない日付は null。
 * CSV の取り込みで使う（保存は YYYY-MM-DD）。
 */
export function normalizeDateInput(raw: string): string | null {
  const m = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "2026-11-03" → "11/3" */
export function shortDateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}
