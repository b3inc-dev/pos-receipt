/**
 * 過去データ取り込み（/app/backfill）を裏で進めるときの「進み具合」の形と、1 日ずつ進める決まり。
 * DB には AppSetting の 1 行（JSON）で持つ（新しい表は作らない）。キューの処理（backfillQueue.server.ts）と画面が使う。
 */

export type BackfillDayStatus = "pending" | "processing" | "done" | "skipped" | "error";
export type BackfillDay = { targetDate: string; status: BackfillDayStatus; reason?: string };
export type BackfillRunState = "running" | "stopped" | "done";

export type BackfillRun = {
  runId: string;
  locationId: string;
  locationName: string;
  /** YYYY-MM */
  month: string;
  state: BackfillRunState;
  days: BackfillDay[];
  startedAt: string;
  updatedAt: string;
};

/** 対象月の日付（今日より先の日は入れない）。today は YYYY-MM-DD（今までの画面と同じく UTC の日付）。 */
export function daysInMonth(month: string, today: string): string[] {
  const [y, m] = month.split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return [];
  const lastDay = new Date(y, m, 0).getDate();
  const days: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (ds > today) break;
    days.push(ds);
  }
  return days;
}

export function newRun(input: {
  runId: string;
  locationId: string;
  locationName: string;
  month: string;
  today: string;
  now: string;
}): BackfillRun {
  return {
    runId: input.runId,
    locationId: input.locationId,
    locationName: input.locationName,
    month: input.month,
    state: "running",
    days: daysInMonth(input.month, input.today).map((targetDate) => ({ targetDate, status: "pending" })),
    startedAt: input.now,
    updatedAt: input.now,
  };
}

/** 次に取り込む日。途中で止まった（processing のまま）日も、もう一度取り込む。 */
export function nextDay(run: BackfillRun): BackfillDay | null {
  return run.days.find((d) => d.status === "processing") ?? run.days.find((d) => d.status === "pending") ?? null;
}

/** 1 日の結果を入れる（ほかの日と、止めた・終わった状態は変えない）。 */
export function withDayResult(run: BackfillRun, targetDate: string, status: BackfillDayStatus, reason: string | undefined, now: string): BackfillRun {
  return {
    ...run,
    days: run.days.map((d) => (d.targetDate === targetDate ? { targetDate, status, ...(reason ? { reason } : {}) } : d)),
    updatedAt: now,
  };
}

/**
 * 続きから再開: 失敗した日と途中の日をもう一度取り込む。済んだ・飛ばした日はそのまま。
 * runId は新しくする。前の鎖のジョブが pg-boss のやり直し待ちで残っていても、runId が違うので何もせずに止まり、
 * 同じ取り込みの鎖が 2 本になって同じ日を 2 回集計することがない。
 */
export function resumedRun(run: BackfillRun, now: string, runId: string): BackfillRun {
  return {
    ...run,
    runId,
    state: "running",
    days: run.days.map((d) => (d.status === "error" || d.status === "processing" ? { targetDate: d.targetDate, status: "pending" } : d)),
    updatedAt: now,
  };
}

export function finishedIfNoneLeft(run: BackfillRun, now: string): BackfillRun {
  if (run.state !== "running" || nextDay(run)) return run;
  return { ...run, state: "done", updatedAt: now };
}

export function runCounts(run: BackfillRun | null) {
  const days = run?.days ?? [];
  const processed = days.filter((d) => d.status === "done" || d.status === "skipped" || d.status === "error").length;
  const errors = days.filter((d) => d.status === "error").length;
  return { total: days.length, processed, errors };
}

/** AppSetting から読んだ値が進み具合の形か（壊れた値・古い形は無いものとして扱う）。 */
export function asRun(value: unknown): BackfillRun | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<BackfillRun>;
  if (typeof v.runId !== "string" || typeof v.locationId !== "string" || !Array.isArray(v.days)) return null;
  if (v.state !== "running" && v.state !== "stopped" && v.state !== "done") return null;
  return v as BackfillRun;
}
