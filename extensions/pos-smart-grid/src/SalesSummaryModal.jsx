/**
 * 売上サマリーモーダル
 * 精算メイン画面と同型: 固定ヘッダー + s-scroll-box + 固定フッター
 *
 * - スコープ: この店舗（セッションロケーション） / 全店舗（locationIds 省略＝API が有効店すべて）
 * - 粒度: 日次 / 月次（期間はその月の1日〜当日または月末）
 * - 日次: 一品単価の下に当月MTDの月予算・遂行など（期間APIを並列取得）
 * - スクロール: 全店舗時は先頭に全店合計、その下に店舗別のリスト行（精算プレビュー型）
 * - フッター左: 入店数報告ボタン（日次・この店のみ・対象店で表示／command で s-modal を開く）
 * - フッター右: 日別一覧（/api/sales-summary/month-daily・比較用KPI付きリスト）
 * - 日別一覧で日付タップ: メインの日付は据え置きで historyDaily へ（入店数報告は単一店・日次のみ）
 * - 日別一覧の「戻る」は常に売上サマリーTOPへ
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "preact/hooks";
import { render } from "preact";
import {
  getDailySummary,
  getPeriodSummary,
  getSalesMonthDaily,
  reportFootfall,
} from "../../common/salesSummaryApi.js";
import { getAvailableMonths } from "../../common/settlementApi.js";
import { getLocationsFromShopify } from "../../common/shopifyAdminGraphql.js";
import { useSessionLocation } from "../../common/sessionLocation.js";
import { toUserMessage } from "../../common/errorMessage.js";

export default async () => {
  render(<SalesSummaryModal />, document.body);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** 端末のローカル暦での「今日」（UTC の toISOString は日本時間早朝に前日になるため使わない） */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthRange(year, month) {
  const dateFrom = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const lastStr = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  const today = todayStr();
  const dateTo = lastStr > today ? today : lastStr;
  /** 実績は dateTo まで。月予算は API で budgetDateTo（月末）まで積む */
  return { dateFrom, dateTo, budgetDateTo: lastStr };
}

/** 日次で選択中の日を含む月の 1日〜その日（実績）・月末まで（月予算） */
function monthRangeForTargetDate(ymdStr) {
  const parts = String(ymdStr || "").split("-");
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!y || !m || m < 1 || m > 12) return null;
  const dateFrom = `${y}-${pad2(m)}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const lastStr = `${y}-${pad2(m)}-${pad2(lastDay)}`;
  let cap = ymdStr;
  if (cap > lastStr) cap = lastStr;
  if (cap < dateFrom) cap = dateFrom;
  return { dateFrom, dateTo: cap, budgetDateTo: lastStr };
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function clampDay(year, month, day) {
  const max = daysInMonth(year, month);
  const n = Number(day);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > max) return max;
  return n;
}

function ymd(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseYmdLocal(ymdStr) {
  const [y, m, d] = String(ymdStr || "").split("-").map((v) => parseInt(v, 10));
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

function toYmdLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfWeek(date, weekStartsOn) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=Sun ... 6=Sat
  const startOffset = weekStartsOn === "sunday" ? day : (day + 6) % 7;
  d.setDate(d.getDate() - startOffset);
  return d;
}

function endOfWeek(date, weekStartsOn) {
  const s = startOfWeek(date, weekStartsOn);
  const e = new Date(s);
  e.setDate(s.getDate() + 6);
  return e;
}

function clampDateToToday(date) {
  const t = parseYmdLocal(todayStr());
  return date > t ? t : date;
}

function addDays(ymd, delta) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** shopCalendarToday: API の calendarToday（店舗タイムゾーン）。無いときは端末ローカル今日。 */
function isTodayDate(ymd, shopCalendarToday) {
  const cap = shopCalendarToday != null && shopCalendarToday !== "" ? shopCalendarToday : todayStr();
  return ymd === cap;
}

function formatUpdatedTimeLabel(dateObj) {
  if (!dateObj) return "";
  const hh = pad2(dateObj.getHours());
  const mm = pad2(dateObj.getMinutes());
  return `${hh}:${mm}更新`;
}

function UpdatedAtBadge({ dateObj }) {
  if (!dateObj) return null;
  return <s-badge tone="info">{formatUpdatedTimeLabel(dateObj)}</s-badge>;
}

function fmtNum(n, dec = 0) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("ja-JP", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

function fmtPct(n) {
  if (n === null || n === undefined) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function fmtAmount(n) {
  if (n === null || n === undefined) return "—";
  return `¥${fmtNum(n)}`;
}

/** サマリー行の locationId と POS セッション GID を照合（数値のみ / GID 形式の差を吸収） */
function locationIdsMatch(a, b) {
  if (a == null || b == null) return false;
  const na = String(a).trim();
  const nb = String(b).trim();
  if (na === nb) return true;
  const ra = na.replace(/^gid:\/\/shopify\/Location\//i, "");
  const rb = nb.replace(/^gid:\/\/shopify\/Location\//i, "");
  return ra.length > 0 && ra === rb;
}

/** POS Stock と同様: command="--show" / commandFor={id} で開く（showOverlay だけだと未マウントで失敗しやすい） */
const FOOTFALL_MODAL_ID_MAIN = "pos-receipt-footfall-modal-main";
const FOOTFALL_MODAL_ID_HISTORY = "pos-receipt-footfall-modal-history";

function hideFootfallModal(modalRef) {
  try {
    modalRef?.current?.hideOverlay?.();
    modalRef?.current?.hide?.();
  } catch (_) {}
}

function defaultDisplayOptions() {
  return {
    showLocationRows: true,
    showChannelRows: true,
    showChannelOnTile: true,
    showStoreTotals: true,
    showBudget: true,
    showActual: true,
    showBudgetRatio: true,
    showOrders: true,
    showVisitors: true,
    showConv: true,
    showAtv: true,
    showSetRate: true,
    showItems: true,
    showUnitPrice: true,
    showMonthBudget: true,
    showMonthActual: true,
    showMonthAchvRatio: true,
    showProgressToday: true,
    showProgressPrev: true,
  };
}

function hasAnyDailyKpi(o) {
  return (
    o.showActual ||
    o.showBudget ||
    o.showBudgetRatio ||
    o.showOrders ||
    o.showVisitors ||
    o.showConv ||
    o.showAtv ||
    o.showSetRate ||
    o.showItems ||
    o.showUnitPrice ||
    o.showMonthBudget ||
    o.showMonthActual ||
    o.showMonthAchvRatio ||
    o.showProgressToday ||
    o.showProgressPrev
  );
}

function hasAnyPeriodKpi(o) {
  return (
    o.showMonthActual ||
    o.showMonthBudget ||
    o.showMonthAchvRatio ||
    o.showProgressToday ||
    o.showProgressPrev ||
    o.showOrders ||
    o.showVisitors ||
    o.showConv ||
    o.showAtv ||
    o.showSetRate ||
    o.showItems ||
    o.showUnitPrice
  );
}

/** 入店数入力（POS Stock 同型: s-modal に id を付け command で開閉） */
function FootfallReportModalHost({
  modalId,
  onRequestClose,
  heading,
  dateLine,
  value,
  onChange,
  onSave,
  saving,
  footfallErr,
  modalRef,
}) {
  return (
    <s-modal id={modalId} ref={modalRef} heading={heading}>
      <s-box padding="base">
        <s-stack gap="base">
          {dateLine ? (
            <s-text tone="subdued" size="small">
              {dateLine}
            </s-text>
          ) : null}
          <s-text-field
            label="入店数（人）"
            value={value}
            onInput={(e) => onChange(e.detail?.value ?? e.target?.value ?? value)}
            onChange={(e) => onChange(e.detail?.value ?? e.target?.value ?? value)}
          />
          {footfallErr ? (
            <s-text tone="critical" size="small">
              {footfallErr}
            </s-text>
          ) : null}
        </s-stack>
      </s-box>
      <s-button
        slot="secondary-actions"
        command="--hide"
        commandFor={modalId}
        onClick={onRequestClose}
      >
        閉じる
      </s-button>
      <s-button slot="primary-action" onClick={onSave} loading={saving}>
        保存
      </s-button>
    </s-modal>
  );
}

// ── Summary 1行（精算プレビューと同型）──────────────────────────────────────────

function SummaryRow({ label, value, valueBold = false, labelBold = false, divider = true }) {
  return (
    <s-stack gap="none">
      <s-box padding="small">
        <s-stack
          direction="inline"
          justifyContent="space-between"
          alignItems="center"
          gap="small"
          style={{ width: "100%" }}
        >
          <s-box style={{ flex: "1 1 0", minInlineSize: 0, paddingInlineEnd: "small" }}>
            <s-text tone="subdued" size="small" fontWeight={labelBold ? "bold" : undefined}>
              {label}
            </s-text>
          </s-box>
          <s-box style={{ flex: "0 1 auto", minInlineSize: 0, textAlign: "end" }}>
            <s-text fontWeight={valueBold ? "bold" : undefined} size="small">
              {value}
            </s-text>
          </s-box>
        </s-stack>
      </s-box>
      {divider ? <s-divider /> : null}
    </s-stack>
  );
}

function MetricBlock({ title, children }) {
  return (
    <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-box padding="small" paddingBlockEnd="none">
        {typeof title === "string" ? (
          <s-text emphasis="bold" size="small">
            {title}
          </s-text>
        ) : (
          title
        )}
      </s-box>
      <s-stack gap="none">{children}</s-stack>
    </s-box>
  );
}

// ── 日次・月次の行データ ─────────────────────────────────────────────────────

function dailyKpiRows(row, o) {
  const rows = [];
  if (o.showActual) rows.push({ label: "実績", value: fmtAmount(row.actual), valueBold: true });
  if (o.showBudget && row.budget !== null)
    rows.push({ label: "予算", value: fmtAmount(row.budget) });
  if (o.showBudgetRatio && row.budgetRatio !== null) {
    rows.push({
      label: "予算比",
      value: fmtPct(row.budgetRatio),
      tone: row.budgetRatio >= 1 ? "success" : "critical",
    });
  }
  if (o.showOrders) rows.push({ label: "件数", value: `${fmtNum(row.orders)}件` });
  if (o.showVisitors && row.visitors !== null)
    rows.push({ label: "入店数", value: `${fmtNum(row.visitors)}人` });
  if (o.showConv && row.conv !== null) rows.push({ label: "購買率", value: fmtPct(row.conv) });
  if (o.showAtv && row.atv !== null) rows.push({ label: "客単価", value: fmtAmount(row.atv) });
  if (o.showSetRate && row.setRate !== null)
    rows.push({ label: "セット率", value: fmtNum(row.setRate, 2) });
  if (o.showItems) rows.push({ label: "点数", value: `${fmtNum(row.items)}点` });
  if (o.showUnitPrice && row.unit !== null) rows.push({ label: "一品単価", value: fmtAmount(row.unit) });
  return rows;
}

/** tone は SummaryRow が未対応のため value に含めずそのまま表示 */
function DailyMetricRows({ row, o, periodRow }) {
  const base = dailyKpiRows(row, o);
  const items = mergeDailyRowsWithMonthKpi(base, periodRow, o);
  return items.map((r, i) => (
    <SummaryRow
      key={`${r.label}-${i}`}
      label={r.label}
      value={r.value}
      valueBold={r.valueBold}
      divider={i < items.length - 1}
    />
  ));
}

function periodKpiRows(row, o) {
  const rows = [];
  if (o.showMonthActual) rows.push({ label: "月実績", value: fmtAmount(row.actualTotal), valueBold: true });
  if (o.showMonthBudget && row.budgetTotal !== null)
    rows.push({ label: "月予算", value: fmtAmount(row.budgetTotal) });
  if (o.showMonthAchvRatio && row.achievementRate !== null) {
    rows.push({
      label: "達成率",
      value: fmtPct(row.achievementRate),
    });
  }
  if (row.progressBudgetToday > 0 && o.showProgressToday) {
    rows.push({ label: "遂行予算(当日)", value: fmtAmount(row.progressBudgetToday) });
    rows.push({ label: "遂行率(当日)", value: fmtPct(row.progressRateToday) });
  }
  if (row.progressBudgetPrev > 0 && o.showProgressPrev) {
    rows.push({ label: "遂行予算(前日)", value: fmtAmount(row.progressBudgetPrev) });
    rows.push({ label: "遂行率(前日)", value: fmtPct(row.progressRatePrev) });
  }
  if (o.showOrders) rows.push({ label: "件数", value: `${fmtNum(row.orders)}件` });
  if (o.showVisitors && row.visitors !== null)
    rows.push({ label: "入店数", value: `${fmtNum(row.visitors)}人` });
  if (o.showConv && row.conv !== null) rows.push({ label: "購買率", value: fmtPct(row.conv) });
  if (o.showAtv && row.atv !== null) rows.push({ label: "客単価", value: fmtAmount(row.atv) });
  if (o.showSetRate && row.setRate !== null)
    rows.push({ label: "セット率", value: fmtNum(row.setRate, 2) });
  if (o.showItems) rows.push({ label: "点数", value: `${fmtNum(row.items)}点` });
  if (o.showUnitPrice && row.unit !== null) rows.push({ label: "一品単価", value: fmtAmount(row.unit) });
  return rows;
}

function PeriodMetricRows({ row, o }) {
  const items = periodKpiRows(row, o);
  return items.map((r, i) => (
    <SummaryRow
      key={`${r.label}-${i}`}
      label={r.label}
      value={r.value}
      valueBold={r.valueBold}
      divider={i < items.length - 1}
    />
  ));
}

function totalsDailyRows(totals, o) {
  const rows = [];
  if (o.showActual) rows.push({ label: "実績", value: fmtAmount(totals.actual), valueBold: true });
  if (o.showBudget && totals.budget !== null) rows.push({ label: "予算", value: fmtAmount(totals.budget) });
  const budgetRatio =
    totals.budget != null && totals.budget > 0 ? totals.actual / totals.budget : null;
  if (o.showBudgetRatio && budgetRatio !== null) {
    rows.push({ label: "予算比", value: fmtPct(budgetRatio) });
  }
  if (o.showOrders) rows.push({ label: "件数", value: `${fmtNum(totals.orders)}件` });
  if (o.showVisitors && totals.visitors !== null)
    rows.push({ label: "入店数", value: `${fmtNum(totals.visitors)}人` });
  const conv =
    totals.visitors != null && totals.visitors > 0 ? totals.orders / totals.visitors : null;
  if (o.showConv && conv !== null) rows.push({ label: "購買率", value: fmtPct(conv) });
  const atv = totals.orders > 0 ? totals.actual / totals.orders : null;
  if (o.showAtv && atv !== null) rows.push({ label: "客単価", value: fmtAmount(atv) });
  const setRate = totals.orders > 0 ? totals.items / totals.orders : null;
  if (o.showSetRate && setRate !== null) rows.push({ label: "セット率", value: fmtNum(setRate, 2) });
  if (o.showItems) rows.push({ label: "点数", value: `${fmtNum(totals.items)}点` });
  const unit = totals.items > 0 ? totals.actual / totals.items : null;
  if (o.showUnitPrice && unit !== null) rows.push({ label: "一品単価", value: fmtAmount(unit) });
  return rows;
}

/** 全店合計用: 期間 API の totals を月次KPI行向けに整形 */
function totalsToPseudoPeriodRow(totals, locationRows = []) {
  const actualTotal = Number(totals.actualTotal ?? 0);
  const budgetTotal = totals.budgetTotal != null ? totals.budgetTotal : null;
  const progressBudgetToday =
    totals.progressBudgetToday != null && totals.progressBudgetToday !== undefined
      ? Number(totals.progressBudgetToday)
      : locationRows.reduce((s, r) => s + Number(r.progressBudgetToday ?? 0), 0);
  const progressBudgetPrev =
    totals.progressBudgetPrev != null && totals.progressBudgetPrev !== undefined
      ? Number(totals.progressBudgetPrev)
      : locationRows.reduce((s, r) => s + Number(r.progressBudgetPrev ?? 0), 0);
  return {
    budgetTotal,
    actualTotal,
    achievementRate: budgetTotal != null && budgetTotal > 0 ? actualTotal / budgetTotal : null,
    progressBudgetToday,
    progressBudgetPrev,
    progressRateToday: progressBudgetToday > 0 ? actualTotal / progressBudgetToday : null,
    progressRatePrev: progressBudgetPrev > 0 ? actualTotal / progressBudgetPrev : null,
  };
}

/** 月予算→月実績→達成率→遂行…（日次で一品単価の直後に挿入） */
function monthKpiRowsOrderedFromPeriodRow(row, o) {
  const items = [];
  if (!row) return items;
  if (o.showMonthBudget && row.budgetTotal !== null)
    items.push({ label: "月予算", value: fmtAmount(row.budgetTotal) });
  if (o.showMonthActual)
    items.push({ label: "月実績", value: fmtAmount(row.actualTotal), valueBold: true });
  if (o.showMonthAchvRatio && row.achievementRate !== null) {
    items.push({
      label: "達成率",
      value: fmtPct(row.achievementRate),
    });
  }
  if (row.progressBudgetToday > 0 && o.showProgressToday) {
    items.push({ label: "遂行予算(当日)", value: fmtAmount(row.progressBudgetToday) });
    items.push({ label: "遂行率(当日)", value: fmtPct(row.progressRateToday) });
  }
  if (row.progressBudgetPrev > 0 && o.showProgressPrev) {
    items.push({ label: "遂行予算(前日)", value: fmtAmount(row.progressBudgetPrev) });
    items.push({ label: "遂行率(前日)", value: fmtPct(row.progressRatePrev) });
  }
  return items;
}

function mergeDailyRowsWithMonthKpi(baseItems, periodRow, o) {
  if (!periodRow) return baseItems;
  const wantMonth =
    o.showMonthBudget ||
    o.showMonthActual ||
    o.showMonthAchvRatio ||
    o.showProgressToday ||
    o.showProgressPrev;
  if (!wantMonth) return baseItems;
  const extra = monthKpiRowsOrderedFromPeriodRow(periodRow, o);
  if (extra.length === 0) return baseItems;
  const idx = baseItems.findIndex((r) => r.label === "一品単価");
  if (idx === -1) return [...baseItems, ...extra];
  return [...baseItems.slice(0, idx + 1), ...extra, ...baseItems.slice(idx + 1)];
}

/** 日次の1行（店舗 or チャネル）に対応する期間API行 */
function pickPeriodRowForDailyLine(dailyMonthPeriod, row) {
  if (!dailyMonthPeriod) return null;
  if (row.channelId != null) {
    return dailyMonthPeriod.channelRows?.find((pr) => pr.channelId === row.channelId) ?? null;
  }
  return dailyMonthPeriod.rows?.find((pr) => locationIdsMatch(pr.locationId, row.locationId)) ?? null;
}

/**
 * 期間の全店合計行。予算・達成率は API totals（店舗＋チャネル＝管理画面「総合計」と同じ）。
 * 遂行予算は API が progressBudgetToday/Prev を返す場合はそれを使用（チャネル込み）、無ければ店舗行のみ合算。
 */
function totalsPeriodRows(totals, o, locationRows = []) {
  const rows = [];
  const actualTotal = Number(totals.actualTotal ?? 0);
  if (o.showMonthActual) rows.push({ label: "月実績", value: fmtAmount(totals.actualTotal), valueBold: true });
  if (o.showMonthBudget && totals.budgetTotal !== null)
    rows.push({ label: "月予算", value: fmtAmount(totals.budgetTotal) });
  if (o.showMonthAchvRatio && totals.budgetTotal != null && totals.budgetTotal > 0) {
    rows.push({
      label: "達成率",
      value: fmtPct(actualTotal / totals.budgetTotal),
    });
  }
  const progressBudgetToday =
    totals.progressBudgetToday != null && totals.progressBudgetToday !== undefined
      ? Number(totals.progressBudgetToday)
      : locationRows.reduce((s, r) => s + Number(r.progressBudgetToday ?? 0), 0);
  const progressBudgetPrev =
    totals.progressBudgetPrev != null && totals.progressBudgetPrev !== undefined
      ? Number(totals.progressBudgetPrev)
      : locationRows.reduce((s, r) => s + Number(r.progressBudgetPrev ?? 0), 0);
  if (progressBudgetToday > 0 && o.showProgressToday) {
    rows.push({ label: "遂行予算(当日)", value: fmtAmount(progressBudgetToday) });
    rows.push({ label: "遂行率(当日)", value: fmtPct(actualTotal / progressBudgetToday) });
  }
  if (progressBudgetPrev > 0 && o.showProgressPrev) {
    rows.push({ label: "遂行予算(前日)", value: fmtAmount(progressBudgetPrev) });
    rows.push({ label: "遂行率(前日)", value: fmtPct(actualTotal / progressBudgetPrev) });
  }
  if (o.showOrders) rows.push({ label: "件数", value: `${fmtNum(totals.orders)}件` });
  if (o.showVisitors && totals.visitors !== null)
    rows.push({ label: "入店数", value: `${fmtNum(totals.visitors)}人` });
  if (o.showConv && totals.conv !== null) rows.push({ label: "購買率", value: fmtPct(totals.conv) });
  if (o.showAtv && totals.atv !== null) rows.push({ label: "客単価", value: fmtAmount(totals.atv) });
  if (o.showSetRate && totals.setRate !== null)
    rows.push({ label: "セット率", value: fmtNum(totals.setRate, 2) });
  if (o.showItems) rows.push({ label: "点数", value: `${fmtNum(totals.items)}点` });
  if (o.showUnitPrice && totals.unit !== null) rows.push({ label: "一品単価", value: fmtAmount(totals.unit) });
  return rows;
}

// ── 日別一覧サブ画面（精算メインと同型：固定ヘッダー＋スクロール＋固定フッター）────────

function DailyListView({
  locationGid,
  locationName,
  initialYear,
  initialMonth,
  initialYmYear,
  availableMonths,
  monthsLoading,
  onBack,
  onPickDate,
}) {
  const [listYear, setListYear] = useState(initialYear);
  const [listMonth, setListMonth] = useState(initialMonth);
  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);

  const [rows, setRows] = useState([]);
  const [listDisplayOpts, setListDisplayOpts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const listO = useMemo(() => ({ ...defaultDisplayOptions(), ...(listDisplayOpts ?? {}) }), [listDisplayOpts]);

  useEffect(() => {
    setListYear(initialYear);
    setListMonth(initialMonth);
  }, [initialYear, initialMonth]);

  const listAvailableYears = useMemo(() => {
    const set = new Set(
      availableMonths.map((ym) => parseInt(ym.split("-")[0], 10)).filter(Boolean)
    );
    const arr = Array.from(set).sort((a, b) => b - a);
    if (arr.length === 0) return [initialYmYear];
    return arr;
  }, [availableMonths, initialYmYear]);

  const listAvailableMonthsForYear = useMemo(() => {
    const set = new Set(
      availableMonths
        .filter((ym) => parseInt(ym.split("-")[0], 10) === listYear)
        .map((ym) => parseInt(ym.split("-")[1], 10))
        .filter(Boolean)
    );
    let arr = Array.from(set).sort((a, b) => b - a);
    if (arr.length === 0) {
      const now = new Date();
      const curY = now.getFullYear();
      const curM = now.getMonth() + 1;
      const maxM = listYear === curY ? curM : 12;
      arr = Array.from({ length: maxM }, (_, i) => maxM - i);
    }
    return arr;
  }, [availableMonths, listYear]);

  useEffect(() => {
    if (listAvailableYears.length && !listAvailableYears.includes(listYear)) {
      setListYear(listAvailableYears[0]);
    }
  }, [listAvailableYears, listYear]);

  useEffect(() => {
    if (listAvailableMonthsForYear.length && !listAvailableMonthsForYear.includes(listMonth)) {
      setListMonth(listAvailableMonthsForYear[0]);
    }
  }, [listAvailableMonthsForYear, listMonth]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const res = await getSalesMonthDaily({ locationId: locationGid, year: listYear, month: listMonth });
        if (!cancelled) {
          setRows(res?.rows ?? []);
          setListDisplayOpts(res?.displayOptions ?? null);
        }
      } catch (e) {
        if (!cancelled) setErr(toUserMessage(e?.message) || "日別一覧の取得に失敗しました");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locationGid, listYear, listMonth]);

  const displayName = locationName?.trim() || "ロケーション";

  return (
    <s-page heading="日別一覧">
      <s-stack
        gap="none"
        blockSize="100%"
        inlineSize="100%"
        minBlockSize="0"
        style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
      >
        <s-box
          padding="base"
          border="base"
          style={{
            position: "sticky",
            top: 0,
            background: "var(--s-color-bg)",
            zIndex: 10,
          }}
        >
          <s-stack gap="small">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" style={{ width: "100%" }}>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                <s-text emphasis="bold" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {displayName}
                </s-text>
              </s-box>
              <s-stack direction="inline" gap="small" alignItems="center" justifyContent="end" style={{ flex: "0 0 auto" }}>
                <s-box style={{ inlineSize: "5.25rem", flex: "0 0 5.25rem" }}>
                  <s-button
                    kind="secondary"
                    style={{ width: "100%", maxInlineSize: "100%" }}
                    onClick={() => {
                      setMonthMenuOpen(false);
                      setYearMenuOpen((v) => !v);
                    }}
                  >
                    {listYear}年
                  </s-button>
                </s-box>
                <s-box style={{ inlineSize: "5.25rem", flex: "0 0 5.25rem" }}>
                  <s-button
                    kind="secondary"
                    style={{ width: "100%", maxInlineSize: "100%" }}
                    onClick={() => {
                      setYearMenuOpen(false);
                      setMonthMenuOpen((v) => !v);
                    }}
                  >
                    {listMonth}月
                  </s-button>
                </s-box>
              </s-stack>
            </s-stack>
            {yearMenuOpen ? (
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack
                  direction="inline"
                  gap="small"
                  style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}
                >
                  {listAvailableYears.length === 0 ? (
                    <s-text tone="subdued" fontSize="small">
                      選べる年がありません
                    </s-text>
                  ) : (
                    listAvailableYears.map((y) => (
                      <s-button
                        key={`dl-year-${y}`}
                        kind={y === listYear ? "primary" : "secondary"}
                        style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                        onClick={() => {
                          setListYear(y);
                          setYearMenuOpen(false);
                        }}
                      >
                        {y}年
                      </s-button>
                    ))
                  )}
                </s-stack>
              </s-box>
            ) : null}
            {monthMenuOpen ? (
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack
                  direction="inline"
                  gap="small"
                  style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}
                >
                  {monthsLoading ? (
                    <s-text tone="subdued" fontSize="small">
                      月一覧を読み込み中…
                    </s-text>
                  ) : listAvailableMonthsForYear.length === 0 ? (
                    <s-text tone="subdued" fontSize="small">
                      選べる月がありません
                    </s-text>
                  ) : (
                    listAvailableMonthsForYear.map((m) => (
                      <s-button
                        key={`dl-month-${m}`}
                        kind={m === listMonth ? "primary" : "secondary"}
                        style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                        onClick={() => {
                          setListMonth(m);
                          setMonthMenuOpen(false);
                        }}
                      >
                        {m}月
                      </s-button>
                    ))
                  )}
                </s-stack>
              </s-box>
            ) : null}
          </s-stack>
        </s-box>

        <s-divider />

        <s-scroll-box blockSize="auto" maxBlockSize="100%" minBlockSize="0" style={{ flex: "1 1 0", minHeight: 0 }}>
          <s-box padding="base">
            <s-stack gap="base">
              {loading ? (
                <s-text tone="subdued" size="small">
                  読み込み中…
                </s-text>
              ) : err ? (
                <s-stack gap="small">
                  <s-text tone="critical">{err}</s-text>
                </s-stack>
              ) : rows.length === 0 ? (
                <s-text tone="subdued" size="small">
                  表示できる日がありません
                </s-text>
              ) : (
                <s-stack gap="base">
                  {rows.map((row) => (
                    <s-clickable key={row.targetDate} onClick={() => onPickDate(row.targetDate)}>
                      <s-box padding="small">
                        <s-stack
                          direction="inline"
                          alignItems="start"
                          gap="small"
                          style={{ width: "100%" }}
                        >
                          <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                            <s-stack gap="extraSmall">
                              <s-text emphasis="bold" size="small">
                                {row.targetDate}
                              </s-text>
                              <s-text tone="subdued" size="small">
                                純売上
                              </s-text>
                              <s-text size="small">
                                {listO.showActual !== false ? fmtAmount(row.netSales) : "—"}
                              </s-text>
                              <s-text tone="subdued" size="small">
                                点数
                              </s-text>
                              <s-text size="small">
                                {listO.showItems !== false && row.items != null
                                  ? `${fmtNum(row.items)}点`
                                  : "—"}
                              </s-text>
                            </s-stack>
                          </s-box>
                          <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                            <s-stack gap="extraSmall">
                              <s-text tone="subdued" size="small">
                                客数
                              </s-text>
                              <s-text size="small">
                                {listO.showOrders !== false && row.orders != null
                                  ? `${fmtNum(row.orders)}件`
                                  : "—"}
                              </s-text>
                              <s-text tone="subdued" size="small">
                                入店数
                              </s-text>
                              <s-text size="small">
                                {listO.showVisitors !== false && row.visitors != null
                                  ? `${fmtNum(row.visitors)}人`
                                  : "—"}
                              </s-text>
                              <s-text tone="subdued" size="small">
                                購買率
                              </s-text>
                              <s-text size="small">
                                {listO.showConv !== false ? fmtPct(row.conv) : "—"}
                              </s-text>
                            </s-stack>
                          </s-box>
                          <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                            <s-stack gap="extraSmall">
                              <s-text tone="subdued" size="small">
                                客単価
                              </s-text>
                              <s-text size="small">
                                {listO.showAtv !== false ? fmtAmount(row.atv) : "—"}
                              </s-text>
                              <s-text tone="subdued" size="small">
                                セット率
                              </s-text>
                              <s-text size="small">
                                {listO.showSetRate !== false ? fmtNum(row.setRate, 2) : "—"}
                              </s-text>
                              <s-text tone="subdued" size="small">
                                一品単価
                              </s-text>
                              <s-text size="small">
                                {listO.showUnitPrice !== false ? fmtAmount(row.unit) : "—"}
                              </s-text>
                            </s-stack>
                          </s-box>
                        </s-stack>
                      </s-box>
                      <s-divider />
                    </s-clickable>
                  ))}
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-scroll-box>

        <s-divider />

        <s-box
          padding="base"
          border="base"
          style={{
            position: "sticky",
            bottom: 0,
            background: "var(--s-color-bg)",
            zIndex: 10,
          }}
        >
          <s-stack direction="inline" justifyContent="start" alignItems="center" gap="base">
            <s-button kind="secondary" onClick={onBack}>
              戻る
            </s-button>
          </s-stack>
        </s-box>
      </s-stack>
    </s-page>
  );
}

// ── 日別一覧から開く「履歴の日次明細」（メインの targetDate は変えない）────────────────

function HistoryDailyDetailView({
  entryDate,
  sessionGid,
  sessionLocationName,
  locLoadErr,
  onNavigateToDailyList,
}) {
  const [viewDate, setViewDate] = useState(entryDate);
  const [scope, setScope] = useState("single");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState(null);
  const [footerFootfallInput, setFooterFootfallInput] = useState("");
  const [savingFootfall, setSavingFootfall] = useState(false);
  const [footfallErr, setFootfallErr] = useState("");
  const historyFootfallModalRef = useRef(null);

  useEffect(() => {
    setViewDate(entryDate);
  }, [entryDate]);

  const locationIdsForApi = useMemo(() => {
    if (scope === "single") return sessionGid ? [sessionGid] : [];
    return [];
  }, [scope, sessionGid]);

  const historyParamsKey = useMemo(
    () => JSON.stringify({ viewDate, scope, sessionGid: sessionGid ?? "", locIds: locationIdsForApi }),
    [viewDate, scope, sessionGid, locationIdsForApi],
  );
  const [loadedHistoryParamsKey, setLoadedHistoryParamsKey] = useState(null);

  const loadData = useCallback(async () => {
    const keyForRequest = historyParamsKey;
    setLoading(true);
    setError("");
    try {
      if (scope === "single" && !sessionGid) {
        setData(null);
        setLoadedHistoryParamsKey(null);
        setError("ロケーションを取得できませんでした。POSで店舗を選択してから開き直してください。");
        return;
      }
      const result = await getDailySummary({ targetDate: viewDate, locationIds: locationIdsForApi });
      setData(result);
      setLoadedHistoryParamsKey(keyForRequest);
      setLastLoadedAt(new Date());
      if (result?.rows && scope === "single" && sessionGid) {
        const sessionRow = result.rows.find((r) => locationIdsMatch(r.locationId, sessionGid));
        if (sessionRow && sessionRow.visitors != null) {
          setFooterFootfallInput(String(sessionRow.visitors));
        } else {
          setFooterFootfallInput("");
        }
      } else if (result?.rows) {
        setFooterFootfallInput("");
      }
    } catch (err) {
      setError(toUserMessage(err?.message));
      setData(null);
      setLoadedHistoryParamsKey(null);
    } finally {
      setLoading(false);
    }
  }, [viewDate, locationIdsForApi, scope, sessionGid, historyParamsKey]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    hideFootfallModal(historyFootfallModalRef);
  }, [scope]);

  useEffect(() => {
    hideFootfallModal(historyFootfallModalRef);
  }, [viewDate]);

  const o = useMemo(() => ({ ...defaultDisplayOptions(), ...(data?.displayOptions ?? {}) }), [data]);
  const rows = data?.rows ?? [];
  const channelRows = data?.channelRows ?? [];
  const showChannelRowsFlag = o.showChannelRows !== false;
  // チャネル（EC 等）は「全店舗表示」時のみ一覧に出す。単一ロケーション時は店舗行のみ。
  const channelRowsForUi =
    scope === "all" && showChannelRowsFlag ? channelRows : [];
  const totals = data?.totals ?? {};
  const showLocationRows = o.showLocationRows !== false;
  const showStoreTotalsFlag = o.showStoreTotals !== false;
  const showAllTotals =
    scope === "all" && (rows.length >= 1 || channelRowsForUi.length >= 1) && showStoreTotalsFlag;
  const totalsDaily = totalsDailyRows(totals, o);
  const showTotalsSection = showAllTotals && totalsDaily.length > 0;

  let rowsForUi = [];
  if (showLocationRows) rowsForUi = rows;
  else if (scope === "single")
    rowsForUi = sessionGid ? rows.filter((r) => locationIdsMatch(r.locationId, sessionGid)) : rows;
  else rowsForUi = [];

  const sessionRow = useMemo(() => {
    if (!sessionGid || !rows.length) return null;
    return rows.find((r) => locationIdsMatch(r.locationId, sessionGid)) ?? null;
  }, [sessionGid, rows]);
  const handleSaveFooterFootfall = async () => {
    if (!sessionGid) return;
    const raw = String(footerFootfallInput ?? "").trim();
    if (raw === "") {
      setFootfallErr("人数を入力してください");
      return;
    }
    const visitors = parseInt(raw, 10);
    if (Number.isNaN(visitors) || visitors < 0) {
      setFootfallErr("0以上の整数を入力してください");
      return;
    }
    setSavingFootfall(true);
    setFootfallErr("");
    try {
      await reportFootfall({ locationId: sessionGid, targetDate: viewDate, visitors });
      await loadData();
      hideFootfallModal(historyFootfallModalRef);
    } catch (err) {
      setFootfallErr(toUserMessage(err?.message) || "保存に失敗しました");
    } finally {
      setSavingFootfall(false);
    }
  };

  const canPrevDay = viewDate > "2020-01-01";
  const historyTodayCap = data?.calendarToday ?? todayStr();
  const canNextDay = viewDate < historyTodayCap;

  const historyDataFresh = loadedHistoryParamsKey === historyParamsKey;
  const historyShowLoading = loading || (!historyDataFresh && !error);

  const kpiHidden =
    !loading &&
    historyDataFresh &&
    data &&
    (rows.length > 0 || channelRowsForUi.length > 0) &&
    !hasAnyDailyKpi(o);
  const layoutEmpty =
    !loading &&
    historyDataFresh &&
    data &&
    (rows.length > 0 || channelRowsForUi.length > 0) &&
    !showTotalsSection &&
    rowsForUi.length === 0 &&
    channelRowsForUi.length === 0 &&
    !kpiHidden;
  const showUpdatedBadge = isTodayDate(viewDate, data?.calendarToday) && !!lastLoadedAt;

  return (
    <>
      <s-page heading="売上サマリー">
        <s-stack
          gap="none"
          blockSize="100%"
          inlineSize="100%"
          minBlockSize="0"
          style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
        >
          <s-box
            padding="base"
            border="base"
            style={{
              position: "sticky",
              top: 0,
              background: "var(--s-color-bg)",
              zIndex: 10,
            }}
          >
            <s-stack gap="small">
              {locLoadErr ? (
                <s-text tone="critical" size="small">
                  {locLoadErr}
                </s-text>
              ) : null}
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" inlineSize="100%">
                <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                  <s-stack gap="extraSmall">
                    <s-text emphasis="bold" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {sessionLocationName || "店舗名を取得中…"}
                    </s-text>
                    <s-text tone="subdued" size="small">
                      日次（履歴） {viewDate}
                    </s-text>
                    {scope === "all" ? (
                      <s-text tone="subdued" size="small">
                        表示: 全店舗
                      </s-text>
                    ) : null}
                  </s-stack>
                </s-box>
                <s-box style={{ flex: "0 0 auto" }}>
                  <s-button
                    variant={scope === "all" ? "primary" : "secondary"}
                    onClick={() => setScope(scope === "all" ? "single" : "all")}
                  >
                    全店舗表示
                  </s-button>
                </s-box>
              </s-stack>

              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                <s-button kind="secondary" disabled={!canPrevDay} onClick={() => setViewDate(addDays(viewDate, -1))}>
                  前日
                </s-button>
                <s-text emphasis="bold" size="small">
                  {viewDate}
                </s-text>
                <s-button kind="secondary" disabled={!canNextDay} onClick={() => setViewDate(addDays(viewDate, 1))}>
                  翌日
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>

          <s-divider />

          <s-scroll-box
            blockSize="auto"
            maxBlockSize="100%"
            minBlockSize="0"
            style={{ flex: "1 1 0", minHeight: 0 }}
          >
            <s-box padding="base">
              <s-stack gap="base">
                {historyShowLoading ? (
                  <s-text tone="subdued" size="small">
                    読み込み中…
                  </s-text>
                ) : null}
                {error ? (
                  <s-banner status="critical">{error}</s-banner>
                ) : null}

                {kpiHidden ? (
                  <s-banner status="info">
                    表示する数字の項目がすべてOFFです。管理画面の売上サマリー設定で、実績や件数などをONにしてください。
                  </s-banner>
                ) : null}

                {layoutEmpty ? (
                  <s-banner status="info">
                    店舗ごとの一覧と店舗合計の両方が非表示です。管理画面で「ロケーション行を表示」または「店舗合計を表示」をONにしてください。
                  </s-banner>
                ) : null}

                {!loading && data && historyDataFresh && (
                  <>
                    {rows.length === 0 && channelRowsForUi.length === 0 ? (
                      <s-text tone="subdued" size="small">
                        売上サマリーが有効な店舗がありません。管理画面でロケーション設定を確認してください。
                      </s-text>
                    ) : (
                      <>
                        {showTotalsSection ? (
                          <MetricBlock title="全店合計">
                            {totalsDaily.map((r, i, arr) => (
                              <SummaryRow
                                key={r.label}
                                label={r.label}
                                value={r.value}
                                valueBold={r.valueBold}
                                divider={i < arr.length - 1}
                              />
                            ))}
                          </MetricBlock>
                        ) : null}

                        {rowsForUi.map((row) => (
                          <s-stack key={row.locationId} gap="small">
                            <MetricBlock
                              title={
                                <s-stack
                                  direction="inline"
                                  justifyContent="space-between"
                                  alignItems="center"
                                  gap="small"
                                  style={{ width: "100%" }}
                                >
                                  <s-text emphasis="bold" size="small">
                                    {row.locationName ?? row.locationId}
                                  </s-text>
                                  {showUpdatedBadge ? <UpdatedAtBadge dateObj={lastLoadedAt} /> : null}
                                </s-stack>
                              }
                            >
                              <DailyMetricRows row={row} o={o} />
                            </MetricBlock>
                          </s-stack>
                        ))}
                        {channelRowsForUi.map((row) => (
                          <s-stack key={row.channelId} gap="small">
                            <MetricBlock
                              title={
                                <s-text emphasis="bold" size="small">
                                  [{row.channelName ?? row.channelId}]
                                </s-text>
                              }
                            >
                              <DailyMetricRows row={row} o={o} />
                            </MetricBlock>
                          </s-stack>
                        ))}
                      </>
                    )}
                  </>
                )}
              </s-stack>
            </s-box>
          </s-scroll-box>

          <s-divider />

          <s-box
            padding="base"
            border="base"
            style={{
              position: "sticky",
              bottom: 0,
              background: "var(--s-color-bg)",
              zIndex: 10,
            }}
          >
            <s-stack direction="inline" alignItems="center" gap="base" style={{ width: "100%" }}>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                <s-stack alignItems="start">
                  <s-button kind="secondary" onClick={loadData} loading={loading}>
                    更新
                  </s-button>
                </s-stack>
              </s-box>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                <s-stack alignItems="center">
                  {scope === "single" && sessionRow?.footfallReportingEnabled ? (
                    <s-stack gap="extraSmall" alignItems="center">
                      <s-button
                        kind="secondary"
                        command="--show"
                        commandFor={FOOTFALL_MODAL_ID_HISTORY}
                        onClick={() => setFootfallErr("")}
                      >
                        {footerFootfallInput
                          ? `入店数報告（${footerFootfallInput}人）`
                          : "入店数報告"}
                      </s-button>
                      {footfallErr ? (
                        <s-text tone="critical" size="small">
                          {footfallErr}
                        </s-text>
                      ) : null}
                    </s-stack>
                  ) : null}
                </s-stack>
              </s-box>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                <s-stack alignItems="end">
                  <s-button kind="secondary" onClick={onNavigateToDailyList}>
                    日別一覧
                  </s-button>
                </s-stack>
              </s-box>
            </s-stack>
          </s-box>
        </s-stack>
      </s-page>
      <FootfallReportModalHost
        modalId={FOOTFALL_MODAL_ID_HISTORY}
        modalRef={historyFootfallModalRef}
        onRequestClose={() => setFootfallErr("")}
        heading="入店数報告"
        dateLine={`対象日: ${viewDate}`}
        value={footerFootfallInput}
        onChange={(v) => setFooterFootfallInput(v)}
        onSave={handleSaveFooterFootfall}
        saving={savingFootfall}
        footfallErr={footfallErr}
      />
    </>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

function SalesSummaryModal() {
  const [step, setStep] = useState("main");
  const [historyDate, setHistoryDate] = useState(null);
  const [scope, setScope] = useState("single");
  const [grain, setGrain] = useState("daily");
  const [targetDate, setTargetDate] = useState(() => todayStr());
  /** 店舗の「今日」YYYY-MM-DD（日次 API の calendarToday。次へ日ボタン上限・更新バッジ用） */
  const [shopCalendarDay, setShopCalendarDay] = useState(null);
  const initialYm = useMemo(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }, []);
  const [selectedYear, setSelectedYear] = useState(initialYm.year);
  const [selectedMonth, setSelectedMonth] = useState(initialYm.month);
  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);
  const [periodStartYear, setPeriodStartYear] = useState(initialYm.year);
  const [periodStartMonth, setPeriodStartMonth] = useState(initialYm.month);
  const [periodStartDay, setPeriodStartDay] = useState(1);
  const [periodEndYear, setPeriodEndYear] = useState(initialYm.year);
  const [periodEndMonth, setPeriodEndMonth] = useState(initialYm.month);
  const [periodEndDay, setPeriodEndDay] = useState(new Date().getDate());
  const [periodAppliedFrom, setPeriodAppliedFrom] = useState(() => {
    const now = new Date();
    return ymd(now.getFullYear(), now.getMonth() + 1, 1);
  });
  const [periodAppliedTo, setPeriodAppliedTo] = useState(todayStr());
  const [periodStartYearMenuOpen, setPeriodStartYearMenuOpen] = useState(false);
  const [periodStartMonthMenuOpen, setPeriodStartMonthMenuOpen] = useState(false);
  const [periodStartDayMenuOpen, setPeriodStartDayMenuOpen] = useState(false);
  const [periodEndYearMenuOpen, setPeriodEndYearMenuOpen] = useState(false);
  const [periodEndMonthMenuOpen, setPeriodEndMonthMenuOpen] = useState(false);
  const [periodEndDayMenuOpen, setPeriodEndDayMenuOpen] = useState(false);

  const [shopLocations, setShopLocations] = useState([]);
  const [locLoadErr, setLocLoadErr] = useState("");

  const [availableMonths, setAvailableMonths] = useState([]);
  const [monthsLoading, setMonthsLoading] = useState(false);

  const [data, setData] = useState(null);
  /** 日次タブ: 当月MTDの期間API結果（一品単価の下の月次KPI用） */
  const [dailyMonthPeriod, setDailyMonthPeriod] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState(null);

  const [footerFootfallInput, setFooterFootfallInput] = useState("");
  const [savingFootfall, setSavingFootfall] = useState(false);
  const [footfallErr, setFootfallErr] = useState("");
  const mainFootfallModalRef = useRef(null);

  const { locationGid: sessionGid, isReady: sessionReady } = useSessionLocation();

  const sessionLocationName = useMemo(() => {
    if (!sessionGid) return "";
    const hit = shopLocations.find((l) => locationIdsMatch(l.locationId, sessionGid));
    return hit?.locationName ?? "";
  }, [sessionGid, shopLocations]);

  useEffect(() => {
    getLocationsFromShopify(50)
      .then((res) => setShopLocations(res?.locations ?? []))
      .catch((e) => setLocLoadErr(toUserMessage(e?.message) || "店舗一覧の取得に失敗しました"));
  }, []);

  const loadAvailableMonths = useCallback(async () => {
    if (!sessionGid) {
      setAvailableMonths([]);
      return;
    }
    setMonthsLoading(true);
    try {
      const res = await getAvailableMonths({ locationId: sessionGid });
      setAvailableMonths(res?.months ?? []);
    } catch {
      setAvailableMonths([]);
    } finally {
      setMonthsLoading(false);
    }
  }, [sessionGid]);

  useEffect(() => {
    if (sessionReady && sessionGid) loadAvailableMonths();
  }, [sessionReady, sessionGid, loadAvailableMonths]);

  const availableYears = useMemo(() => {
    const set = new Set(
      availableMonths.map((ym) => parseInt(ym.split("-")[0], 10)).filter(Boolean)
    );
    const arr = Array.from(set).sort((a, b) => b - a);
    if (arr.length === 0) return [initialYm.year];
    return arr;
  }, [availableMonths, initialYm.year]);

  const availableMonthsForYear = useMemo(() => {
    const set = new Set(
      availableMonths
        .filter((ym) => parseInt(ym.split("-")[0], 10) === selectedYear)
        .map((ym) => parseInt(ym.split("-")[1], 10))
        .filter(Boolean)
    );
    let arr = Array.from(set).sort((a, b) => b - a);
    if (arr.length === 0) {
      const now = new Date();
      const curY = now.getFullYear();
      const curM = now.getMonth() + 1;
      const maxM = selectedYear === curY ? curM : 12;
      arr = Array.from({ length: maxM }, (_, i) => maxM - i);
    }
    return arr;
  }, [availableMonths, selectedYear]);

  useEffect(() => {
    if (availableYears.length && !availableYears.includes(selectedYear)) {
      const y = availableYears[0];
      setSelectedYear(y);
    }
  }, [availableYears, selectedYear]);

  useEffect(() => {
    if (availableMonthsForYear.length && !availableMonthsForYear.includes(selectedMonth)) {
      setSelectedMonth(availableMonthsForYear[0]);
    }
  }, [availableMonthsForYear, selectedMonth]);

  useEffect(() => {
    setPeriodStartDay((d) => clampDay(periodStartYear, periodStartMonth, d));
  }, [periodStartYear, periodStartMonth]);

  useEffect(() => {
    setPeriodEndDay((d) => clampDay(periodEndYear, periodEndMonth, d));
  }, [periodEndYear, periodEndMonth]);

  const locationIdsForApi = useMemo(() => {
    if (scope === "single") {
      return sessionGid ? [sessionGid] : [];
    }
    return [];
  }, [scope, sessionGid]);

  const summaryParamsKey = useMemo(
    () =>
      JSON.stringify({
        scope,
        sessionGid: sessionGid ?? "",
        grain,
        targetDate,
        selectedYear,
        selectedMonth,
        periodAppliedFrom,
        periodAppliedTo,
        locationIds: locationIdsForApi,
      }),
    [
      scope,
      sessionGid,
      grain,
      targetDate,
      selectedYear,
      selectedMonth,
      periodAppliedFrom,
      periodAppliedTo,
      locationIdsForApi,
    ],
  );
  const [loadedSummaryParamsKey, setLoadedSummaryParamsKey] = useState(null);

  const loadData = useCallback(async () => {
    const keyForRequest = summaryParamsKey;
    setLoading(true);
    setError("");
    try {
      if (scope === "single" && !sessionGid) {
        setData(null);
        setDailyMonthPeriod(null);
        setLoadedSummaryParamsKey(null);
        setError("ロケーションを取得できませんでした。POSで店舗を選択してから開き直してください。");
        return;
      }
      let result;
      if (grain === "daily") {
        const mr = monthRangeForTargetDate(targetDate);
        const [dailySettled, monthSettled] = await Promise.allSettled([
          getDailySummary({ targetDate, locationIds: locationIdsForApi }),
          mr
            ? getPeriodSummary({
                dateFrom: mr.dateFrom,
                dateTo: mr.dateTo,
                budgetDateTo: mr.budgetDateTo,
                progressAsOfDate: targetDate,
                locationIds: locationIdsForApi,
              })
            : Promise.resolve(null),
        ]);
        if (dailySettled.status === "rejected") {
          const reason = dailySettled.reason;
          throw reason instanceof Error ? reason : new Error(String(reason));
        }
        result = dailySettled.value;
        if (monthSettled.status === "fulfilled" && monthSettled.value?.rows) {
          setDailyMonthPeriod(monthSettled.value);
        } else {
          setDailyMonthPeriod(null);
        }
      } else if (grain === "monthly") {
        setDailyMonthPeriod(null);
        const { dateFrom, dateTo, budgetDateTo } = monthRange(selectedYear, selectedMonth);
        result = await getPeriodSummary({
          dateFrom,
          dateTo,
          budgetDateTo,
          locationIds: locationIdsForApi,
        });
      } else {
        setDailyMonthPeriod(null);
        const dateFrom = periodAppliedFrom;
        const dateTo = periodAppliedTo;
        if (dateFrom > dateTo) {
          setData(null);
          setDailyMonthPeriod(null);
          setLoadedSummaryParamsKey(null);
          setError("開始日は終了日以前にしてください");
          return;
        }
        result = await getPeriodSummary({ dateFrom, dateTo, locationIds: locationIdsForApi });
      }
      setData(result);
      setLoadedSummaryParamsKey(keyForRequest);
      setLastLoadedAt(new Date());
      if (grain === "daily" && result?.calendarToday) {
        setShopCalendarDay(result.calendarToday);
      }
      if (result?.rows && grain === "daily" && scope === "single" && sessionGid) {
        const sessionRow = result.rows.find((r) => locationIdsMatch(r.locationId, sessionGid));
        if (sessionRow && sessionRow.visitors != null) {
          setFooterFootfallInput(String(sessionRow.visitors));
        } else {
          setFooterFootfallInput("");
        }
      } else if (result?.rows && grain === "daily") {
        setFooterFootfallInput("");
      }
    } catch (err) {
      setError(toUserMessage(err?.message));
      setData(null);
      setDailyMonthPeriod(null);
      setLoadedSummaryParamsKey(null);
    } finally {
      setLoading(false);
    }
  }, [summaryParamsKey, scope, sessionGid, grain, targetDate, selectedYear, selectedMonth, periodAppliedFrom, periodAppliedTo, locationIdsForApi]);

  useEffect(() => {
    if (sessionReady) {
      loadData();
    }
  }, [sessionReady, loadData]);

  useEffect(() => {
    hideFootfallModal(mainFootfallModalRef);
  }, [grain, scope]);

  useEffect(() => {
    hideFootfallModal(mainFootfallModalRef);
  }, [targetDate]);

  const o = useMemo(() => ({ ...defaultDisplayOptions(), ...(data?.displayOptions ?? {}) }), [data]);

  const rows = data?.rows ?? [];
  const channelRows = data?.channelRows ?? [];
  const showChannelRowsFlag = o.showChannelRows !== false;
  const channelRowsForUi =
    scope === "all" && showChannelRowsFlag ? channelRows : [];
  const totals = data?.totals ?? {};
  const showLocationRows = o.showLocationRows !== false;
  const showStoreTotalsFlag = o.showStoreTotals !== false;
  const showAllTotals =
    scope === "all" && (rows.length >= 1 || channelRowsForUi.length >= 1) && showStoreTotalsFlag;
  const totalsDaily = useMemo(() => {
    const base = totalsDailyRows(totals, o);
    if (grain !== "daily" || !dailyMonthPeriod?.totals) return base;
    const pseudo = totalsToPseudoPeriodRow(dailyMonthPeriod.totals, dailyMonthPeriod.rows ?? []);
    return mergeDailyRowsWithMonthKpi(base, pseudo, o);
  }, [totals, o, grain, dailyMonthPeriod]);
  const totalsPeriod = totalsPeriodRows(totals, o, rows);
  const showTotalsSectionDaily = showAllTotals && grain === "daily" && totalsDaily.length > 0;
  const showTotalsSectionMonthly = showAllTotals && grain !== "daily" && totalsPeriod.length > 0;

  let rowsForUi = [];
  if (showLocationRows) rowsForUi = rows;
  else if (scope === "single")
    rowsForUi = sessionGid ? rows.filter((r) => locationIdsMatch(r.locationId, sessionGid)) : rows;
  else rowsForUi = [];

  const summaryDataFresh = loadedSummaryParamsKey === summaryParamsKey;
  const summaryShowLoading =
    loading || (sessionReady && !summaryDataFresh && !error);

  const kpiHidden =
    !loading &&
    summaryDataFresh &&
    data &&
    (rows.length > 0 || channelRowsForUi.length > 0) &&
    (grain === "daily" ? !hasAnyDailyKpi(o) : !hasAnyPeriodKpi(o));
  const showUpdatedBadge =
    grain === "daily" && isTodayDate(targetDate, shopCalendarDay) && !!lastLoadedAt;
  const layoutEmpty =
    !loading &&
    summaryDataFresh &&
    data &&
    (rows.length > 0 || channelRowsForUi.length > 0) &&
    !(showTotalsSectionDaily || showTotalsSectionMonthly) &&
    rowsForUi.length === 0 &&
    channelRowsForUi.length === 0 &&
    !kpiHidden;

  const sessionRow = useMemo(() => {
    if (!sessionGid || !rows.length) return null;
    return rows.find((r) => locationIdsMatch(r.locationId, sessionGid)) ?? null;
  }, [sessionGid, rows]);

  const weekStartsOn = o.weekStartsOn === "sunday" ? "sunday" : "monday";

  const applyPeriodRange = useCallback((fromYmd, toYmd, options = {}) => {
    const from = parseYmdLocal(fromYmd);
    const to = clampDateToToday(parseYmdLocal(toYmd));
    const safeTo = to < from ? from : to;
    const nextFrom = ymd(from.getFullYear(), from.getMonth() + 1, from.getDate());
    const nextTo = ymd(safeTo.getFullYear(), safeTo.getMonth() + 1, safeTo.getDate());

    setPeriodStartYear(from.getFullYear());
    setPeriodStartMonth(from.getMonth() + 1);
    setPeriodStartDay(from.getDate());
    setPeriodEndYear(safeTo.getFullYear());
    setPeriodEndMonth(safeTo.getMonth() + 1);
    setPeriodEndDay(safeTo.getDate());
    if (options.apply) {
      setPeriodAppliedFrom(nextFrom);
      setPeriodAppliedTo(nextTo);
    }
  }, []);

  const applyPeriodPreset = useCallback(
    (preset, options = {}) => {
      const base = parseYmdLocal(todayStr());
      if (preset === "thisMonth") {
        const from = new Date(base.getFullYear(), base.getMonth(), 1);
        applyPeriodRange(toYmdLocal(from), toYmdLocal(base), options);
        return;
      }
      if (preset === "lastMonth") {
        const from = new Date(base.getFullYear(), base.getMonth() - 1, 1);
        const to = new Date(base.getFullYear(), base.getMonth(), 0);
        applyPeriodRange(toYmdLocal(from), toYmdLocal(to), options);
        return;
      }
      if (preset === "lastWeek") {
        const currentWeekStart = startOfWeek(base, weekStartsOn);
        const from = new Date(currentWeekStart);
        from.setDate(currentWeekStart.getDate() - 7);
        const to = endOfWeek(from, weekStartsOn);
        applyPeriodRange(toYmdLocal(from), toYmdLocal(to), options);
        return;
      }
      const from = startOfWeek(base, weekStartsOn);
      const to = endOfWeek(base, weekStartsOn);
      applyPeriodRange(toYmdLocal(from), toYmdLocal(to), options);
    },
    [applyPeriodRange, weekStartsOn]
  );

  const handleSaveFooterFootfall = async () => {
    if (!sessionGid || grain !== "daily") return;
    const raw = String(footerFootfallInput ?? "").trim();
    if (raw === "") {
      setFootfallErr("人数を入力してください");
      return;
    }
    const visitors = parseInt(raw, 10);
    if (Number.isNaN(visitors) || visitors < 0) {
      setFootfallErr("0以上の整数を入力してください");
      return;
    }
    setSavingFootfall(true);
    setFootfallErr("");
    try {
      await reportFootfall({ locationId: sessionGid, targetDate, visitors });
      await loadData();
      hideFootfallModal(mainFootfallModalRef);
    } catch (err) {
      setFootfallErr(toUserMessage(err?.message) || "保存に失敗しました");
    } finally {
      setSavingFootfall(false);
    }
  };

  const dailyListYearMonth = useMemo(() => {
    if (grain === "daily") {
      const y = parseInt(targetDate.slice(0, 4), 10);
      const m = parseInt(targetDate.slice(5, 7), 10);
      return { year: y, month: m };
    }
    return { year: selectedYear, month: selectedMonth };
  }, [grain, targetDate, selectedYear, selectedMonth]);

  const openDailyList = () => {
    if (!sessionGid) return;
    setStep("dailyList");
  };

  /** 日別一覧の日付タップ → メインの日付は据え置き、履歴用の日次明細画面へ */
  const onPickDailyDate = (d) => {
    setHistoryDate(d);
    setStep("historyDaily");
  };

  if (step === "historyDaily" && historyDate && sessionGid) {
    return (
      <HistoryDailyDetailView
        entryDate={historyDate}
        sessionGid={sessionGid}
        sessionLocationName={sessionLocationName}
        locLoadErr={locLoadErr}
        onNavigateToDailyList={() => setStep("dailyList")}
      />
    );
  }

  if (step === "dailyList" && sessionGid) {
    return (
      <DailyListView
        locationGid={sessionGid}
        locationName={sessionLocationName}
        initialYear={dailyListYearMonth.year}
        initialMonth={dailyListYearMonth.month}
        initialYmYear={initialYm.year}
        availableMonths={availableMonths}
        monthsLoading={monthsLoading}
        onBack={() => setStep("main")}
        onPickDate={onPickDailyDate}
      />
    );
  }

  const canPrevDay = targetDate > "2020-01-01";
  const todayCap = shopCalendarDay ?? todayStr();
  const canNextDay = targetDate < todayCap;
  const periodDateFrom = ymd(periodStartYear, periodStartMonth, periodStartDay);
  const periodDateTo = ymd(periodEndYear, periodEndMonth, periodEndDay);
  const periodRangeInvalid = periodDateFrom > periodDateTo;
  const periodDirty =
    periodDateFrom !== periodAppliedFrom || periodDateTo !== periodAppliedTo;

  const showFooterFootfallButton =
    grain === "daily" && scope === "single" && sessionRow?.footfallReportingEnabled;

  return (
    <>
      <s-page heading="売上サマリー">
        <s-stack
          gap="none"
          blockSize="100%"
          inlineSize="100%"
          minBlockSize="0"
          style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
        >
          <s-box
            padding="base"
            border="base"
            style={{
              position: "sticky",
              top: 0,
              background: "var(--s-color-bg)",
              zIndex: 10,
            }}
          >
            <s-stack gap="small">
              {locLoadErr ? (
                <s-text tone="critical" size="small">
                  {locLoadErr}
                </s-text>
              ) : null}
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" inlineSize="100%">
                <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                  <s-stack gap="extraSmall">
                    <s-text emphasis="bold" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {sessionLocationName || "店舗名を取得中…"}
                    </s-text>
                    {scope === "all" ? (
                      <s-text tone="subdued" size="small">
                        表示: 全店舗
                      </s-text>
                    ) : null}
                  </s-stack>
                </s-box>
                <s-box style={{ flex: "0 0 auto" }}>
                  <s-button
                    variant={scope === "all" ? "primary" : "secondary"}
                    onClick={() => setScope(scope === "all" ? "single" : "all")}
                  >
                    全店舗表示
                  </s-button>
                </s-box>
              </s-stack>

              {/* POS Stock 入庫モーダル（未入庫 / 入庫済み）と同型: gap-none + 50% + variant */}
              <s-stack direction="inline" gap="none" inlineSize="100%">
                <s-box inlineSize="33.33%">
                  <s-button
                    variant={grain === "monthly" ? "primary" : "secondary"}
                    onClick={() => {
                      setGrain("monthly");
                      setPeriodStartYearMenuOpen(false);
                      setPeriodStartMonthMenuOpen(false);
                      setPeriodStartDayMenuOpen(false);
                      setPeriodEndYearMenuOpen(false);
                      setPeriodEndMonthMenuOpen(false);
                      setPeriodEndDayMenuOpen(false);
                    }}
                  >
                    月次
                  </s-button>
                </s-box>
                <s-box inlineSize="33.33%">
                  <s-button
                    variant={grain === "period" ? "primary" : "secondary"}
                    onClick={() => {
                      setGrain("period");
                      setYearMenuOpen(false);
                      setMonthMenuOpen(false);
                      applyPeriodPreset("thisWeek", { apply: true });
                    }}
                  >
                    期間指定
                  </s-button>
                </s-box>
                <s-box inlineSize="33.33%">
                  <s-button
                    variant={grain === "daily" ? "primary" : "secondary"}
                    onClick={() => {
                      setGrain("daily");
                      setYearMenuOpen(false);
                      setMonthMenuOpen(false);
                      setPeriodStartYearMenuOpen(false);
                      setPeriodStartMonthMenuOpen(false);
                      setPeriodStartDayMenuOpen(false);
                      setPeriodEndYearMenuOpen(false);
                      setPeriodEndMonthMenuOpen(false);
                      setPeriodEndDayMenuOpen(false);
                    }}
                  >
                    日次
                  </s-button>
                </s-box>
              </s-stack>

              {grain === "daily" ? (
                <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                  <s-button kind="secondary" disabled={!canPrevDay} onClick={() => setTargetDate(addDays(targetDate, -1))}>
                    前日
                  </s-button>
                  <s-text emphasis="bold" size="small">
                    {targetDate}
                  </s-text>
                  <s-button kind="secondary" disabled={!canNextDay} onClick={() => setTargetDate(addDays(targetDate, 1))}>
                    翌日
                  </s-button>
                </s-stack>
              ) : grain === "monthly" ? (
                <s-stack gap="small">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" style={{ width: "100%" }}>
                    <s-box style={{ flex: "0 0 auto" }}>
                      <s-text tone="subdued" size="small">
                        対象月
                      </s-text>
                    </s-box>
                    <s-stack direction="inline" gap="small" alignItems="center" justifyContent="end" style={{ flex: "0 0 auto" }}>
                      <s-box style={{ inlineSize: "5.25rem", flex: "0 0 5.25rem" }}>
                        <s-button
                          kind="secondary"
                          style={{ width: "100%", maxInlineSize: "100%" }}
                          onClick={() => {
                            setMonthMenuOpen(false);
                            setYearMenuOpen((v) => !v);
                          }}
                        >
                          {selectedYear}年
                        </s-button>
                      </s-box>
                      <s-box style={{ inlineSize: "5.25rem", flex: "0 0 5.25rem" }}>
                        <s-button
                          kind="secondary"
                          style={{ width: "100%", maxInlineSize: "100%" }}
                          onClick={() => {
                            setYearMenuOpen(false);
                            setMonthMenuOpen((v) => !v);
                          }}
                        >
                          {selectedMonth}月
                        </s-button>
                      </s-box>
                    </s-stack>
                  </s-stack>
                  {yearMenuOpen ? (
                    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                      <s-stack
                        direction="inline"
                        gap="small"
                        style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}
                      >
                        {availableYears.map((y) => (
                          <s-button
                            key={`y-${y}`}
                            kind={y === selectedYear ? "primary" : "secondary"}
                            style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                            onClick={() => {
                              setSelectedYear(y);
                              setYearMenuOpen(false);
                            }}
                          >
                            {y}年
                          </s-button>
                        ))}
                      </s-stack>
                    </s-box>
                  ) : null}
                  {monthMenuOpen ? (
                    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                      <s-stack
                        direction="inline"
                        gap="small"
                        style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}
                      >
                        {monthsLoading ? (
                          <s-text tone="subdued" size="small">
                            月一覧を読み込み中…
                          </s-text>
                        ) : (
                          availableMonthsForYear.map((m) => (
                            <s-button
                              key={`m-${m}`}
                              kind={m === selectedMonth ? "primary" : "secondary"}
                              style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                              onClick={() => {
                                setSelectedMonth(m);
                                setMonthMenuOpen(false);
                              }}
                            >
                              {m}月
                            </s-button>
                          ))
                        )}
                      </s-stack>
                    </s-box>
                  ) : null}
                </s-stack>
              ) : (
                <s-stack gap="small">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" style={{ width: "100%" }}>
                    <s-box style={{ flex: "0 0 auto" }}>
                      <s-text tone="subdued" size="small">
                        開始日
                      </s-text>
                    </s-box>
                    <s-stack direction="inline" gap="small" alignItems="center" justifyContent="end" style={{ flex: "0 0 auto" }}>
                      <s-box style={{ inlineSize: "4.75rem", flex: "0 0 4.75rem" }}>
                        <s-button
                          kind="secondary"
                          style={{ width: "100%", maxInlineSize: "100%" }}
                          onClick={() => {
                            setPeriodStartMonthMenuOpen(false);
                            setPeriodStartDayMenuOpen(false);
                            setPeriodEndYearMenuOpen(false);
                            setPeriodEndMonthMenuOpen(false);
                            setPeriodEndDayMenuOpen(false);
                            setPeriodStartYearMenuOpen((v) => !v);
                          }}
                        >
                          {periodStartYear}年
                        </s-button>
                      </s-box>
                      <s-box style={{ inlineSize: "4.25rem", flex: "0 0 4.25rem" }}>
                        <s-button
                          kind="secondary"
                          style={{ width: "100%", maxInlineSize: "100%" }}
                          onClick={() => {
                            setPeriodStartYearMenuOpen(false);
                            setPeriodStartDayMenuOpen(false);
                            setPeriodEndYearMenuOpen(false);
                            setPeriodEndMonthMenuOpen(false);
                            setPeriodEndDayMenuOpen(false);
                            setPeriodStartMonthMenuOpen((v) => !v);
                          }}
                        >
                          {periodStartMonth}月
                        </s-button>
                      </s-box>
                      <s-box style={{ inlineSize: "4.25rem", flex: "0 0 4.25rem" }}>
                        <s-button
                          kind="secondary"
                          style={{ width: "100%", maxInlineSize: "100%" }}
                          onClick={() => {
                            setPeriodStartYearMenuOpen(false);
                            setPeriodStartMonthMenuOpen(false);
                            setPeriodEndYearMenuOpen(false);
                            setPeriodEndMonthMenuOpen(false);
                            setPeriodEndDayMenuOpen(false);
                            setPeriodStartDayMenuOpen((v) => !v);
                          }}
                        >
                          {periodStartDay}日
                        </s-button>
                      </s-box>
                    </s-stack>
                  </s-stack>
                  {periodStartYearMenuOpen ? (
                    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                      <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}>
                        {availableYears.map((y) => (
                          <s-button
                            key={`ps-y-${y}`}
                            kind={y === periodStartYear ? "primary" : "secondary"}
                            style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                            onClick={() => {
                              setPeriodStartYear(y);
                              setPeriodStartYearMenuOpen(false);
                            }}
                          >
                            {y}年
                          </s-button>
                        ))}
                      </s-stack>
                    </s-box>
                  ) : null}
                  {periodStartMonthMenuOpen ? (
                    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                      <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}>
                        {monthsLoading ? (
                          <s-text tone="subdued" size="small">
                            月一覧を読み込み中…
                          </s-text>
                        ) : (
                          Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                            <s-button
                              key={`ps-m-${m}`}
                              kind={m === periodStartMonth ? "primary" : "secondary"}
                              style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                              onClick={() => {
                                setPeriodStartMonth(m);
                                setPeriodStartMonthMenuOpen(false);
                              }}
                            >
                              {m}月
                            </s-button>
                          ))
                        )}
                      </s-stack>
                    </s-box>
                  ) : null}
                  {periodStartDayMenuOpen ? (
                    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                      <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}>
                        {Array.from({ length: daysInMonth(periodStartYear, periodStartMonth) }, (_, i) => i + 1).map((d) => (
                          <s-button
                            key={`ps-d-${d}`}
                            kind={d === periodStartDay ? "primary" : "secondary"}
                            style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                            onClick={() => {
                              setPeriodStartDay(d);
                              setPeriodStartDayMenuOpen(false);
                            }}
                          >
                            {d}日
                          </s-button>
                        ))}
                      </s-stack>
                    </s-box>
                  ) : null}

                  <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" style={{ width: "100%" }}>
                    <s-box style={{ flex: "0 0 auto" }}>
                      <s-text tone="subdued" size="small">
                        終了日
                      </s-text>
                    </s-box>
                    <s-stack direction="inline" gap="small" alignItems="center" justifyContent="end" style={{ flex: "0 0 auto" }}>
                      <s-box style={{ inlineSize: "4.75rem", flex: "0 0 4.75rem" }}>
                        <s-button
                          kind="secondary"
                          style={{ width: "100%", maxInlineSize: "100%" }}
                          onClick={() => {
                            setPeriodEndMonthMenuOpen(false);
                            setPeriodEndDayMenuOpen(false);
                            setPeriodStartYearMenuOpen(false);
                            setPeriodStartMonthMenuOpen(false);
                            setPeriodStartDayMenuOpen(false);
                            setPeriodEndYearMenuOpen((v) => !v);
                          }}
                        >
                          {periodEndYear}年
                        </s-button>
                      </s-box>
                      <s-box style={{ inlineSize: "4.25rem", flex: "0 0 4.25rem" }}>
                        <s-button
                          kind="secondary"
                          style={{ width: "100%", maxInlineSize: "100%" }}
                          onClick={() => {
                            setPeriodEndYearMenuOpen(false);
                            setPeriodEndDayMenuOpen(false);
                            setPeriodStartYearMenuOpen(false);
                            setPeriodStartMonthMenuOpen(false);
                            setPeriodStartDayMenuOpen(false);
                            setPeriodEndMonthMenuOpen((v) => !v);
                          }}
                        >
                          {periodEndMonth}月
                        </s-button>
                      </s-box>
                      <s-box style={{ inlineSize: "4.25rem", flex: "0 0 4.25rem" }}>
                        <s-button
                          kind="secondary"
                          style={{ width: "100%", maxInlineSize: "100%" }}
                          onClick={() => {
                            setPeriodEndYearMenuOpen(false);
                            setPeriodEndMonthMenuOpen(false);
                            setPeriodStartYearMenuOpen(false);
                            setPeriodStartMonthMenuOpen(false);
                            setPeriodStartDayMenuOpen(false);
                            setPeriodEndDayMenuOpen((v) => !v);
                          }}
                        >
                          {periodEndDay}日
                        </s-button>
                      </s-box>
                    </s-stack>
                  </s-stack>
                  {periodEndYearMenuOpen ? (
                    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                      <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}>
                        {availableYears.map((y) => (
                          <s-button
                            key={`pe-y-${y}`}
                            kind={y === periodEndYear ? "primary" : "secondary"}
                            style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                            onClick={() => {
                              setPeriodEndYear(y);
                              setPeriodEndYearMenuOpen(false);
                            }}
                          >
                            {y}年
                          </s-button>
                        ))}
                      </s-stack>
                    </s-box>
                  ) : null}
                  {periodEndMonthMenuOpen ? (
                    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                      <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}>
                        {monthsLoading ? (
                          <s-text tone="subdued" size="small">
                            月一覧を読み込み中…
                          </s-text>
                        ) : (
                          Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                            <s-button
                              key={`pe-m-${m}`}
                              kind={m === periodEndMonth ? "primary" : "secondary"}
                              style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                              onClick={() => {
                                setPeriodEndMonth(m);
                                setPeriodEndMonthMenuOpen(false);
                              }}
                            >
                              {m}月
                            </s-button>
                          ))
                        )}
                      </s-stack>
                    </s-box>
                  ) : null}
                  {periodEndDayMenuOpen ? (
                    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                      <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}>
                        {Array.from({ length: daysInMonth(periodEndYear, periodEndMonth) }, (_, i) => i + 1).map((d) => (
                          <s-button
                            key={`pe-d-${d}`}
                            kind={d === periodEndDay ? "primary" : "secondary"}
                            style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                            onClick={() => {
                              setPeriodEndDay(d);
                              setPeriodEndDayMenuOpen(false);
                            }}
                          >
                            {d}日
                          </s-button>
                        ))}
                      </s-stack>
                    </s-box>
                  ) : null}
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%", flexWrap: "wrap" }}>
                    <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap" }}>
                      <s-button kind="secondary" onClick={() => applyPeriodPreset("thisWeek")}>
                        今週
                      </s-button>
                      <s-button kind="secondary" onClick={() => applyPeriodPreset("lastWeek")}>
                        先週
                      </s-button>
                      <s-button kind="secondary" onClick={() => applyPeriodPreset("thisMonth")}>
                        今月
                      </s-button>
                      <s-button kind="secondary" onClick={() => applyPeriodPreset("lastMonth")}>
                        先月
                      </s-button>
                    </s-stack>
                    <s-button
                      kind="primary"
                      disabled={!periodDirty || periodRangeInvalid}
                      onClick={() => {
                        setPeriodAppliedFrom(periodDateFrom);
                        setPeriodAppliedTo(periodDateTo);
                      }}
                    >
                      期間適用
                    </s-button>
                  </s-stack>
                </s-stack>
              )}
            </s-stack>
          </s-box>

          <s-divider />

          <s-scroll-box
            blockSize="auto"
            maxBlockSize="100%"
            minBlockSize="0"
            style={{ flex: "1 1 0", minHeight: 0 }}
          >
            <s-box padding="base">
              <s-stack gap="base">
                {summaryShowLoading ? (
                  <s-text tone="subdued" size="small">
                    読み込み中…
                  </s-text>
                ) : null}
                {error ? (
                  <s-banner status="critical">{error}</s-banner>
                ) : null}
                {grain === "period" && periodRangeInvalid ? (
                  <s-banner status="critical">開始日が終了日より後になっています。日付を見直してください。</s-banner>
                ) : null}

                {kpiHidden ? (
                  <s-banner status="info">
                    表示する数字の項目がすべてOFFです。管理画面の売上サマリー設定で、実績や件数などをONにしてください。
                  </s-banner>
                ) : null}

                {layoutEmpty ? (
                  <s-banner status="info">
                    店舗ごとの一覧と店舗合計の両方が非表示です。管理画面で「ロケーション行を表示」または「店舗合計を表示」をONにしてください。
                  </s-banner>
                ) : null}

                {!loading && data && summaryDataFresh && (
                  <>
                    {rows.length === 0 && channelRowsForUi.length === 0 ? (
                      <s-text tone="subdued" size="small">
                        売上サマリーが有効な店舗がありません。管理画面でロケーション設定を確認してください。
                      </s-text>
                    ) : (
                      <>
                        {showTotalsSectionDaily ? (
                          <MetricBlock title="全店合計">
                            {totalsDaily.map((r, i, arr) => (
                              <SummaryRow
                                key={r.label}
                                label={r.label}
                                value={r.value}
                                valueBold={r.valueBold}
                                divider={i < arr.length - 1}
                              />
                            ))}
                          </MetricBlock>
                        ) : null}
                        {showTotalsSectionMonthly ? (
                          <MetricBlock title="全店合計">
                            {totalsPeriod.map((r, i, arr) => (
                              <SummaryRow
                                key={r.label}
                                label={r.label}
                                value={r.value}
                                valueBold={r.valueBold}
                                divider={i < arr.length - 1}
                              />
                            ))}
                          </MetricBlock>
                        ) : null}

                        {rowsForUi.map((row) => (
                          <s-stack key={row.locationId} gap="small">
                            <MetricBlock
                              title={
                                <s-stack
                                  direction="inline"
                                  justifyContent="space-between"
                                  alignItems="center"
                                  gap="small"
                                  style={{ width: "100%" }}
                                >
                                  <s-text emphasis="bold" size="small">
                                    {row.locationName ?? row.locationId}
                                  </s-text>
                                  {showUpdatedBadge ? <UpdatedAtBadge dateObj={lastLoadedAt} /> : null}
                                </s-stack>
                              }
                            >
                              {grain === "daily" ? (
                                <DailyMetricRows
                                  row={row}
                                  o={o}
                                  periodRow={pickPeriodRowForDailyLine(dailyMonthPeriod, row)}
                                />
                              ) : (
                                <PeriodMetricRows row={row} o={o} />
                              )}
                            </MetricBlock>
                          </s-stack>
                        ))}
                        {channelRowsForUi.map((row) => (
                          <s-stack key={row.channelId} gap="small">
                            <MetricBlock
                              title={
                                <s-text emphasis="bold" size="small">
                                  [{row.channelName ?? row.channelId}]
                                </s-text>
                              }
                            >
                              {grain === "daily" ? (
                                <DailyMetricRows
                                  row={row}
                                  o={o}
                                  periodRow={pickPeriodRowForDailyLine(dailyMonthPeriod, row)}
                                />
                              ) : (
                                <PeriodMetricRows row={row} o={o} />
                              )}
                            </MetricBlock>
                          </s-stack>
                        ))}
                      </>
                    )}
                  </>
                )}
              </s-stack>
            </s-box>
          </s-scroll-box>

          <s-divider />

          <s-box
            padding="base"
            border="base"
            style={{
              position: "sticky",
              bottom: 0,
              background: "var(--s-color-bg)",
              zIndex: 10,
            }}
          >
            <s-stack direction="inline" alignItems="center" gap="base" style={{ width: "100%" }}>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                <s-stack alignItems="start">
                  <s-button kind="secondary" onClick={loadData} loading={loading}>
                    更新
                  </s-button>
                </s-stack>
              </s-box>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                <s-stack alignItems="center">
                  {showFooterFootfallButton ? (
                    <s-stack gap="extraSmall" alignItems="center">
                      <s-button
                        kind="secondary"
                        command="--show"
                        commandFor={FOOTFALL_MODAL_ID_MAIN}
                        onClick={() => setFootfallErr("")}
                      >
                        {footerFootfallInput
                          ? `入店数報告（${footerFootfallInput}人）`
                          : "入店数報告"}
                      </s-button>
                      {footfallErr ? (
                        <s-text tone="critical" size="small">
                          {footfallErr}
                        </s-text>
                      ) : null}
                    </s-stack>
                  ) : null}
                </s-stack>
              </s-box>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                <s-stack alignItems="end">
                  <s-button kind="secondary" disabled={!sessionGid} onClick={openDailyList}>
                    日別一覧
                  </s-button>
                </s-stack>
              </s-box>
            </s-stack>
          </s-box>
        </s-stack>
      </s-page>
      <FootfallReportModalHost
        modalId={FOOTFALL_MODAL_ID_MAIN}
        modalRef={mainFootfallModalRef}
        onRequestClose={() => setFootfallErr("")}
        heading="入店数報告"
        dateLine={`対象日: ${targetDate}`}
        value={footerFootfallInput}
        onChange={(v) => setFooterFootfallInput(v)}
        onSave={handleSaveFooterFootfall}
        saving={savingFootfall}
        footfallErr={footfallErr}
      />
    </>
  );
}
