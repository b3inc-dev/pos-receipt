/**
 * 売上サマリーモーダル
 * 精算メイン画面と同型: 固定ヘッダー + s-scroll-box + 固定フッター
 *
 * - スコープ: この店舗（セッションロケーション） / 全店舗（locationIds 省略＝API が有効店すべて）
 * - 粒度: 日次 / 月次（期間はその月の1日〜当日または月末）
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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
  return { dateFrom, dateTo };
}

function addDays(ymd, delta) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function isTodayDate(ymd) {
  return ymd === todayStr();
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
    o.showUnitPrice
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
    o.showItems
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
function DailyMetricRows({ row, o }) {
  const items = dailyKpiRows(row, o);
  return items.map((r, i) => (
    <SummaryRow
      key={r.label}
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
  if (o.showItems) rows.push({ label: "点数", value: `${fmtNum(row.items)}点` });
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
  if (o.showOrders) rows.push({ label: "件数", value: `${fmtNum(totals.orders)}件` });
  if (o.showVisitors && totals.visitors !== null)
    rows.push({ label: "入店数", value: `${fmtNum(totals.visitors)}人` });
  if (o.showItems) rows.push({ label: "点数", value: `${fmtNum(totals.items)}点` });
  return rows;
}

function totalsPeriodRows(totals, o) {
  const rows = [];
  if (o.showMonthActual) rows.push({ label: "月実績", value: fmtAmount(totals.actualTotal), valueBold: true });
  if (o.showMonthBudget && totals.budgetTotal !== null)
    rows.push({ label: "月予算", value: fmtAmount(totals.budgetTotal) });
  if (o.showOrders) rows.push({ label: "件数", value: `${fmtNum(totals.orders)}件` });
  if (o.showItems) rows.push({ label: "点数", value: `${fmtNum(totals.items)}点` });
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

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (scope === "single" && !sessionGid) {
        setData(null);
        setError("ロケーションを取得できませんでした。POSで店舗を選択してから開き直してください。");
        return;
      }
      const result = await getDailySummary({ targetDate: viewDate, locationIds: locationIdsForApi });
      setData(result);
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
    } finally {
      setLoading(false);
    }
  }, [viewDate, locationIdsForApi, scope, sessionGid]);

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
  const totals = data?.totals ?? {};
  const showLocationRows = o.showLocationRows !== false;
  const showStoreTotalsFlag = o.showStoreTotals !== false;
  const showAllTotals = scope === "all" && rows.length >= 1 && showStoreTotalsFlag;
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
  const canNextDay = viewDate < todayStr();

  const kpiHidden = !loading && data && rows.length > 0 && !hasAnyDailyKpi(o);
  const layoutEmpty =
    !loading && data && rows.length > 0 && !showTotalsSection && rowsForUi.length === 0;
  const showUpdatedBadge = isTodayDate(viewDate) && !!lastLoadedAt;

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
                {loading ? (
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

                {!loading && data && (
                  <>
                    {rows.length === 0 ? (
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
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" style={{ width: "100%" }}>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                {scope === "single" && sessionRow?.footfallReportingEnabled ? (
                  <s-stack gap="extraSmall">
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
              </s-box>
              <s-box style={{ flex: "0 0 auto" }}>
                <s-button kind="secondary" onClick={onNavigateToDailyList}>
                  日別一覧
                </s-button>
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
  const [targetDate, setTargetDate] = useState(todayStr);
  const initialYm = useMemo(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }, []);
  const [selectedYear, setSelectedYear] = useState(initialYm.year);
  const [selectedMonth, setSelectedMonth] = useState(initialYm.month);
  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);

  const [shopLocations, setShopLocations] = useState([]);
  const [locLoadErr, setLocLoadErr] = useState("");

  const [availableMonths, setAvailableMonths] = useState([]);
  const [monthsLoading, setMonthsLoading] = useState(false);

  const [data, setData] = useState(null);
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

  const locationIdsForApi = useMemo(() => {
    if (scope === "single") {
      return sessionGid ? [sessionGid] : [];
    }
    return [];
  }, [scope, sessionGid]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (scope === "single" && !sessionGid) {
        setData(null);
        setError("ロケーションを取得できませんでした。POSで店舗を選択してから開き直してください。");
        return;
      }
      let result;
      if (grain === "daily") {
        result = await getDailySummary({ targetDate, locationIds: locationIdsForApi });
      } else {
        const { dateFrom, dateTo } = monthRange(selectedYear, selectedMonth);
        result = await getPeriodSummary({ dateFrom, dateTo, locationIds: locationIdsForApi });
      }
      setData(result);
      setLastLoadedAt(new Date());
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
    } finally {
      setLoading(false);
    }
  }, [scope, sessionGid, grain, targetDate, selectedYear, selectedMonth, locationIdsForApi]);

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
  const totals = data?.totals ?? {};
  const showLocationRows = o.showLocationRows !== false;
  const showStoreTotalsFlag = o.showStoreTotals !== false;
  const showAllTotals = scope === "all" && rows.length >= 1 && showStoreTotalsFlag;
  const totalsDaily = totalsDailyRows(totals, o);
  const totalsPeriod = totalsPeriodRows(totals, o);
  const showTotalsSectionDaily = showAllTotals && grain === "daily" && totalsDaily.length > 0;
  const showTotalsSectionMonthly = showAllTotals && grain === "monthly" && totalsPeriod.length > 0;

  let rowsForUi = [];
  if (showLocationRows) rowsForUi = rows;
  else if (scope === "single")
    rowsForUi = sessionGid ? rows.filter((r) => locationIdsMatch(r.locationId, sessionGid)) : rows;
  else rowsForUi = [];

  const kpiHidden =
    !loading &&
    data &&
    rows.length > 0 &&
    (grain === "daily" ? !hasAnyDailyKpi(o) : !hasAnyPeriodKpi(o));
  const showUpdatedBadge = grain === "daily" && isTodayDate(targetDate) && !!lastLoadedAt;
  const layoutEmpty =
    !loading &&
    data &&
    rows.length > 0 &&
    !(showTotalsSectionDaily || showTotalsSectionMonthly) &&
    rowsForUi.length === 0;

  const sessionRow = useMemo(() => {
    if (!sessionGid || !rows.length) return null;
    return rows.find((r) => locationIdsMatch(r.locationId, sessionGid)) ?? null;
  }, [sessionGid, rows]);

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
  const canNextDay = targetDate < todayStr();

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
                <s-box inlineSize="50%">
                  <s-button
                    variant={grain === "monthly" ? "primary" : "secondary"}
                    onClick={() => setGrain("monthly")}
                  >
                    月次
                  </s-button>
                </s-box>
                <s-box inlineSize="50%">
                  <s-button
                    variant={grain === "daily" ? "primary" : "secondary"}
                    onClick={() => setGrain("daily")}
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
              ) : (
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
                {loading ? (
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

                {!loading && data && (
                  <>
                    {rows.length === 0 ? (
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
                                <DailyMetricRows row={row} o={o} />
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
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" style={{ width: "100%" }}>
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                {showFooterFootfallButton ? (
                  <s-stack gap="extraSmall">
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
              </s-box>
              <s-box style={{ flex: "0 0 auto" }}>
                <s-button kind="secondary" disabled={!sessionGid} onClick={openDailyList}>
                  日別一覧
                </s-button>
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
