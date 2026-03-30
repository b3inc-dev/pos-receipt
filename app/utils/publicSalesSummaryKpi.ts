/**
 * POS 売上サマリーモーダルと同じ KPI 行（ラベル・表示値）を組み立てる（公開ページ用）
 * ※ appSettings.server は import しない（クライアントバンドルに乗るため）
 */
export type SalesSummaryDisplayOpts = {
  showActual?: boolean;
  showBudget?: boolean;
  showBudgetRatio?: boolean;
  showOrders?: boolean;
  showVisitors?: boolean;
  showConv?: boolean;
  showAtv?: boolean;
  showSetRate?: boolean;
  showItems?: boolean;
  showUnitPrice?: boolean;
  showMonthBudget?: boolean;
  showMonthActual?: boolean;
  showMonthAchvRatio?: boolean;
  showProgressToday?: boolean;
  showProgressPrev?: boolean;
  showLocationRows?: boolean;
  showChannelRows?: boolean;
  showStoreTotals?: boolean;
  showOverallTotals?: boolean;
};

/** 未指定は true（merge 済み設定と同じ） */
function on(v: boolean | undefined): boolean {
  return v !== false;
}

const yenFmt = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });
const numFmt = new Intl.NumberFormat("ja-JP");

export function fmtAmount(n: number): string {
  return yenFmt.format(n);
}

export function fmtPct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

export function fmtNum(n: number | null | undefined, decimals = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return numFmt.format(decimals > 0 ? Number(n.toFixed(decimals)) : Math.round(n));
}

export type KpiLine = { label: string; value: string; valueBold?: boolean };

type DailyRowLike = {
  actual: number;
  budget: number | null;
  budgetRatio: number | null;
  orders: number;
  visitors: number | null;
  conv: number | null;
  atv: number | null;
  setRate: number | null;
  items: number;
  unit: number | null;
};

export type PeriodRowLike = {
  locationId?: string;
  locationName?: string;
  channelId?: string;
  channelName?: string;
  actualTotal: number;
  budgetTotal: number | null;
  achievementRate: number | null;
  progressBudgetToday: number;
  progressBudgetPrev: number;
  progressRateToday: number | null;
  progressRatePrev: number | null;
  orders: number;
  visitors: number | null;
  conv: number | null;
  atv: number | null;
  setRate: number | null;
  items: number;
  unit: number | null;
};

type DailyTotalsLike = {
  actual: number;
  budget: number | null;
  orders: number;
  items: number;
  visitors: number | null;
};

type PeriodTotalsLike = {
  actualTotal: number;
  budgetTotal: number | null;
  progressBudgetToday: number;
  progressBudgetPrev: number;
  orders: number;
  items: number;
  visitors: number | null;
  conv: number | null;
  atv: number | null;
  setRate: number | null;
  unit: number | null;
};

export function buildDailyKpiLines(row: DailyRowLike, o: SalesSummaryDisplayOpts): KpiLine[] {
  const rows: KpiLine[] = [];
  if (on(o.showActual)) rows.push({ label: "実績", value: fmtAmount(row.actual), valueBold: true });
  if (on(o.showBudget) && row.budget !== null) rows.push({ label: "予算", value: fmtAmount(row.budget) });
  if (on(o.showBudgetRatio) && row.budgetRatio !== null) {
    rows.push({ label: "予算比", value: fmtPct(row.budgetRatio) });
  }
  if (on(o.showOrders)) rows.push({ label: "件数", value: `${fmtNum(row.orders)}件` });
  if (on(o.showVisitors) && row.visitors !== null) rows.push({ label: "入店数", value: `${fmtNum(row.visitors)}人` });
  if (on(o.showConv) && row.conv !== null) rows.push({ label: "購買率", value: fmtPct(row.conv) });
  if (on(o.showAtv) && row.atv !== null) rows.push({ label: "客単価", value: fmtAmount(row.atv) });
  if (on(o.showSetRate) && row.setRate !== null) rows.push({ label: "セット率", value: fmtNum(row.setRate, 2) });
  if (on(o.showItems)) rows.push({ label: "点数", value: `${fmtNum(row.items)}点` });
  if (on(o.showUnitPrice) && row.unit !== null) rows.push({ label: "一品単価", value: fmtAmount(row.unit) });
  return rows;
}

function monthKpiRowsOrderedFromPeriodRow(row: PeriodRowLike, o: SalesSummaryDisplayOpts): KpiLine[] {
  const items: KpiLine[] = [];
  if (on(o.showMonthBudget) && row.budgetTotal !== null)
    items.push({ label: "月予算", value: fmtAmount(row.budgetTotal) });
  if (on(o.showMonthActual)) items.push({ label: "月実績", value: fmtAmount(row.actualTotal), valueBold: true });
  if (on(o.showMonthAchvRatio) && row.achievementRate !== null) {
    items.push({ label: "達成率", value: fmtPct(row.achievementRate) });
  }
  if (row.progressBudgetToday > 0 && on(o.showProgressToday)) {
    items.push({ label: "遂行予算(当日)", value: fmtAmount(row.progressBudgetToday) });
    items.push({ label: "遂行率(当日)", value: fmtPct(row.progressRateToday) });
  }
  if (row.progressBudgetPrev > 0 && on(o.showProgressPrev)) {
    items.push({ label: "遂行予算(前日)", value: fmtAmount(row.progressBudgetPrev) });
    items.push({ label: "遂行率(前日)", value: fmtPct(row.progressRatePrev) });
  }
  return items;
}

function mergeDailyWithMonthKpi(base: KpiLine[], periodRow: PeriodRowLike | null, o: SalesSummaryDisplayOpts): KpiLine[] {
  if (!periodRow) return base;
  const wantMonth =
    on(o.showMonthBudget) ||
    on(o.showMonthActual) ||
    on(o.showMonthAchvRatio) ||
    on(o.showProgressToday) ||
    on(o.showProgressPrev);
  if (!wantMonth) return base;
  const extra = monthKpiRowsOrderedFromPeriodRow(periodRow, o);
  if (extra.length === 0) return base;
  const idx = base.findIndex((r) => r.label === "一品単価");
  if (idx === -1) return [...base, ...extra];
  return [...base.slice(0, idx + 1), ...extra, ...base.slice(idx + 1)];
}

export function buildDailyKpiLinesWithMonth(
  row: DailyRowLike,
  periodRowForLine: PeriodRowLike | null,
  o: SalesSummaryDisplayOpts,
): KpiLine[] {
  const base = buildDailyKpiLines(row, o);
  return mergeDailyWithMonthKpi(base, periodRowForLine, o);
}

export function buildPeriodKpiLines(row: PeriodRowLike, o: SalesSummaryDisplayOpts): KpiLine[] {
  const rows: KpiLine[] = [];
  if (on(o.showMonthActual)) rows.push({ label: "月実績", value: fmtAmount(row.actualTotal), valueBold: true });
  if (on(o.showMonthBudget) && row.budgetTotal !== null) rows.push({ label: "月予算", value: fmtAmount(row.budgetTotal) });
  if (on(o.showMonthAchvRatio) && row.achievementRate !== null) {
    rows.push({ label: "達成率", value: fmtPct(row.achievementRate) });
  }
  if (row.progressBudgetToday > 0 && on(o.showProgressToday)) {
    rows.push({ label: "遂行予算(当日)", value: fmtAmount(row.progressBudgetToday) });
    rows.push({ label: "遂行率(当日)", value: fmtPct(row.progressRateToday) });
  }
  if (row.progressBudgetPrev > 0 && on(o.showProgressPrev)) {
    rows.push({ label: "遂行予算(前日)", value: fmtAmount(row.progressBudgetPrev) });
    rows.push({ label: "遂行率(前日)", value: fmtPct(row.progressRatePrev) });
  }
  if (on(o.showOrders)) rows.push({ label: "件数", value: `${fmtNum(row.orders)}件` });
  if (on(o.showVisitors) && row.visitors !== null) rows.push({ label: "入店数", value: `${fmtNum(row.visitors)}人` });
  if (on(o.showConv) && row.conv !== null) rows.push({ label: "購買率", value: fmtPct(row.conv) });
  if (on(o.showAtv) && row.atv !== null) rows.push({ label: "客単価", value: fmtAmount(row.atv) });
  if (on(o.showSetRate) && row.setRate !== null) rows.push({ label: "セット率", value: fmtNum(row.setRate, 2) });
  if (on(o.showItems)) rows.push({ label: "点数", value: `${fmtNum(row.items)}点` });
  if (on(o.showUnitPrice) && row.unit !== null) rows.push({ label: "一品単価", value: fmtAmount(row.unit) });
  return rows;
}

export function buildDailyTotalsLines(totals: DailyTotalsLike, o: SalesSummaryDisplayOpts): KpiLine[] {
  const rows: KpiLine[] = [];
  if (on(o.showActual)) rows.push({ label: "実績", value: fmtAmount(totals.actual), valueBold: true });
  if (on(o.showBudget) && totals.budget !== null) rows.push({ label: "予算", value: fmtAmount(totals.budget) });
  const budgetRatio =
    totals.budget != null && totals.budget > 0 ? totals.actual / totals.budget : null;
  if (on(o.showBudgetRatio) && budgetRatio !== null) rows.push({ label: "予算比", value: fmtPct(budgetRatio) });
  if (on(o.showOrders)) rows.push({ label: "件数", value: `${fmtNum(totals.orders)}件` });
  if (on(o.showVisitors) && totals.visitors !== null)
    rows.push({ label: "入店数", value: `${fmtNum(totals.visitors)}人` });
  const conv =
    totals.visitors != null && totals.visitors > 0 ? totals.orders / totals.visitors : null;
  if (on(o.showConv) && conv !== null) rows.push({ label: "購買率", value: fmtPct(conv) });
  const atv = totals.orders > 0 ? totals.actual / totals.orders : null;
  if (on(o.showAtv) && atv !== null) rows.push({ label: "客単価", value: fmtAmount(atv) });
  const setRate = totals.orders > 0 ? totals.items / totals.orders : null;
  if (on(o.showSetRate) && setRate !== null) rows.push({ label: "セット率", value: fmtNum(setRate, 2) });
  if (on(o.showItems)) rows.push({ label: "点数", value: `${fmtNum(totals.items)}点` });
  const unit = totals.items > 0 ? totals.actual / totals.items : null;
  if (on(o.showUnitPrice) && unit !== null) rows.push({ label: "一品単価", value: fmtAmount(unit) });
  return rows;
}

export function buildPeriodTotalsLines(
  totals: PeriodTotalsLike,
  o: SalesSummaryDisplayOpts,
  locationRows: PeriodRowLike[],
): KpiLine[] {
  const rows: KpiLine[] = [];
  const actualTotal = Number(totals.actualTotal ?? 0);
  if (on(o.showMonthActual)) rows.push({ label: "月実績", value: fmtAmount(actualTotal), valueBold: true });
  if (on(o.showMonthBudget) && totals.budgetTotal !== null)
    rows.push({ label: "月予算", value: fmtAmount(totals.budgetTotal) });
  if (on(o.showMonthAchvRatio) && totals.budgetTotal != null && totals.budgetTotal > 0) {
    rows.push({ label: "達成率", value: fmtPct(actualTotal / totals.budgetTotal) });
  }
  const progressBudgetToday =
    totals.progressBudgetToday != null && totals.progressBudgetToday !== undefined
      ? Number(totals.progressBudgetToday)
      : locationRows.reduce((s, r) => s + Number(r.progressBudgetToday ?? 0), 0);
  const progressBudgetPrev =
    totals.progressBudgetPrev != null && totals.progressBudgetPrev !== undefined
      ? Number(totals.progressBudgetPrev)
      : locationRows.reduce((s, r) => s + Number(r.progressBudgetPrev ?? 0), 0);
  if (progressBudgetToday > 0 && on(o.showProgressToday)) {
    rows.push({ label: "遂行予算(当日)", value: fmtAmount(progressBudgetToday) });
    rows.push({ label: "遂行率(当日)", value: fmtPct(actualTotal / progressBudgetToday) });
  }
  if (progressBudgetPrev > 0 && on(o.showProgressPrev)) {
    rows.push({ label: "遂行予算(前日)", value: fmtAmount(progressBudgetPrev) });
    rows.push({ label: "遂行率(前日)", value: fmtPct(actualTotal / progressBudgetPrev) });
  }
  if (on(o.showOrders)) rows.push({ label: "件数", value: `${fmtNum(totals.orders)}件` });
  if (on(o.showVisitors) && totals.visitors !== null)
    rows.push({ label: "入店数", value: `${fmtNum(totals.visitors)}人` });
  if (on(o.showConv) && totals.conv !== null) rows.push({ label: "購買率", value: fmtPct(totals.conv) });
  if (on(o.showAtv) && totals.atv !== null) rows.push({ label: "客単価", value: fmtAmount(totals.atv) });
  if (on(o.showSetRate) && totals.setRate !== null) rows.push({ label: "セット率", value: fmtNum(totals.setRate, 2) });
  if (on(o.showItems)) rows.push({ label: "点数", value: `${fmtNum(totals.items)}点` });
  if (on(o.showUnitPrice) && totals.unit !== null) rows.push({ label: "一品単価", value: fmtAmount(totals.unit) });
  return rows;
}

export function mergeDailyTotalsWithMonth(
  base: KpiLine[],
  periodTotals: PeriodTotalsLike,
  o: SalesSummaryDisplayOpts,
): KpiLine[] {
  const pseudo: PeriodRowLike = {
    actualTotal: Number(periodTotals.actualTotal ?? 0),
    budgetTotal: periodTotals.budgetTotal != null ? periodTotals.budgetTotal : null,
    achievementRate:
      periodTotals.budgetTotal != null && periodTotals.budgetTotal > 0
        ? Number(periodTotals.actualTotal ?? 0) / periodTotals.budgetTotal
        : null,
    progressBudgetToday: Number(periodTotals.progressBudgetToday ?? 0),
    progressBudgetPrev: Number(periodTotals.progressBudgetPrev ?? 0),
    progressRateToday:
      periodTotals.progressBudgetToday > 0
        ? Number(periodTotals.actualTotal ?? 0) / periodTotals.progressBudgetToday
        : null,
    progressRatePrev:
      periodTotals.progressBudgetPrev > 0
        ? Number(periodTotals.actualTotal ?? 0) / periodTotals.progressBudgetPrev
        : null,
    orders: 0,
    visitors: null,
    conv: null,
    atv: null,
    setRate: null,
    items: 0,
    unit: null,
  };
  return mergeDailyWithMonthKpi(base, pseudo, o);
}

export function pickPeriodRowForDailyLine(
  periodPayload: { rows: PeriodRowLike[]; channelRows: PeriodRowLike[] },
  line: { locationId?: string; channelId?: string },
): PeriodRowLike | null {
  if (line.channelId) {
    return periodPayload.channelRows.find((r) => r.channelId === line.channelId) ?? null;
  }
  if (line.locationId) {
    const gid = line.locationId;
    const raw = gid.replace("gid://shopify/Location/", "");
    return (
      periodPayload.rows.find(
        (r) => r.locationId === gid || r.locationId === raw || `gid://shopify/Location/${r.locationId}` === gid,
      ) ?? null
    );
  }
  return null;
}
