/**
 * 精算モーダル
 * 要件書 §6, §23.1
 *
 * Steps:
 *   main     → 固定ヘッダー（ロケーション・年/月）+ 履歴一覧 + 固定フッター
 *   preview  → 精算（集計結果表示）。大事な案内（読み込み中・エラー等）は一覧の上に出す
 *   confirm  → 点検／精算の発行確認（画面ごと切り替える。重ね表示は使わない）
 *   done     → 完了（印字方式別メッセージ）
 *   historyDetail → 精算履歴明細
 */
import { render } from "preact";
import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import {
  getLocations,
  previewSettlement,
  createSettlement,
  recalculateSettlement,
  getAvailableMonths,
  getMonthRows,
} from "../../common/settlementApi.js";
import { getAppUrl } from "../../common/appUrl.js";
import { getLocationsFromShopify } from "../../common/shopifyAdminGraphql.js";
import { useSessionLocation } from "../../common/sessionLocation.js";
import { toUserMessage } from "../../common/errorMessage.js";
import { formatYmdSlash, formatJstHm } from "../../common/dateDisplay.js";
import { specialRefundEventTypeLabel } from "../../common/specialRefundLabels.js";
import { printSettlementReceipt, getPrintSettings } from "../../common/printApi.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";
import { SummaryHeading, SummaryLine, PaymentLine } from "./SummaryTable.jsx";
import { formatYen, formatDeduction, formatYmdWithWeekday } from "../../common/summaryTableLayout.js";

/**
 * 以前の発行確認モーダルの id。
 * 発行確認は「confirm」の画面に切り替える形にした（iPhone の POS で、点検を押しても確認が出ず
 * 見出しだけ変わって見えたため）。s-modal はもう置いていないが、閉じる呼び出しは残しても害はない。
 */
const SETTLEMENT_ISSUE_CONFIRM_INSPECTION_ID = "pos-receipt-settlement-issue-inspection";
const SETTLEMENT_ISSUE_CONFIRM_SETTLE_ID = "pos-receipt-settlement-issue-settle";

function hideSettlementIssueConfirmModals() {
  for (const id of [SETTLEMENT_ISSUE_CONFIRM_INSPECTION_ID, SETTLEMENT_ISSUE_CONFIRM_SETTLE_ID]) {
    try {
      const el = document.getElementById(id);
      el?.hide?.();
      el?.hideOverlay?.();
    } catch (_) {}
  }
}

// ── 今日の日付（YYYY-MM-DD） ────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayYearMonth() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function addDays(ymd, delta) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export default async () => {
  render(<SettlementModal />, document.body);
};

// ── Root ──────────────────────────────────────────────────────────────────────
function SettlementModal() {
  const [step, setStep] = useState("preview");
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [targetDate, setTargetDate] = useState(todayStr());
  const [preview, setPreview] = useState(null);
  const [settlementResult, setSettlementResult] = useState(null);
  const [isInspection, setIsInspection] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 精算の数を読み込んだ時刻（ms）。画面に「HH:MM 時点」と出して、更新が効いたことをわかるようにする */
  const [previewLoadedAt, setPreviewLoadedAt] = useState(null);
  const [locationLoadError, setLocationLoadError] = useState("");
  const [selectedHistoryItem, setSelectedHistoryItem] = useState(null);

  // 新しい月ナビゲーション用 state
  const [availableMonths, setAvailableMonths] = useState([]);
  const [monthsLoading, setMonthsLoading] = useState(false);
  const [monthsError, setMonthsError] = useState("");
  const [monthRows, setMonthRows] = useState([]);
  const [monthRowsLoading, setMonthRowsLoading] = useState(false);
  const [monthRowsError, setMonthRowsError] = useState("");

  const initialYm = useMemo(() => todayYearMonth(), []);
  const [selectedYear, setSelectedYear] = useState(initialYm.year);
  const [selectedMonth, setSelectedMonth] = useState(initialYm.month);
  const [initialPreviewLoaded, setInitialPreviewLoaded] = useState(false);
  // POS Stock と同様: ポーリングでセッションのロケーションが確定するまで待つ
  const { locationGid: sessionLocationGid, isReady: sessionReady } = useSessionLocation();

  // まず Shopify 内蔵 API でロケーション取得（バックエンド不要・Load failed 防止）
  // その後バックエンドで printMode 等を取得してマージ。バックエンド失敗時はデフォルトのまま表示
  const loadLocations = useCallback((gid) => {
    setLoading(true);
    setLocationLoadError("");
    getLocationsFromShopify(50)
      .then((res) => {
        let locs = res.locations ?? [];
        if (gid) {
          locs = locs.filter((l) => l.locationId === gid);
        }
        setLocations(locs);
        const initial = gid ? locs.find((l) => l.locationId === gid) ?? locs[0] : locs[0];
        if (initial) setSelectedLocation(initial);
        // バックエンドから printMode 等を取得してマージ（失敗してもリストは表示済みなのでエラーにしない）
        return getLocations()
          .then((backendRes) => {
            const backendLocs = backendRes?.locations ?? [];
            if (backendLocs.length === 0) return;
            setLocations((prev) =>
              prev.map((p) => {
                const b = backendLocs.find((l) => l.locationId === p.locationId);
                return b ? { ...p, ...b } : p;
              })
            );
          })
          .catch(() => {});
      })
      .catch((e) => setLocationLoadError(toUserMessage(e?.message) || "ロケーションの取得に失敗しました"))
      .finally(() => setLoading(false));
  }, []);

  const loadAvailableMonths = useCallback(async (locationId) => {
    if (!locationId) {
      setAvailableMonths([]);
      return;
    }
    setMonthsLoading(true);
    setMonthsError("");
    try {
      const res = await getAvailableMonths({ locationId });
      setAvailableMonths(res?.months ?? []);
    } catch (e) {
      setMonthsError(toUserMessage(e?.message) || "月一覧の取得に失敗しました");
      setAvailableMonths([]);
    } finally {
      setMonthsLoading(false);
    }
  }, []);

  // セッションのロケーションが確定したらロケーション一覧をロード
  useEffect(() => {
    if (sessionReady) {
      loadLocations(sessionLocationGid);
    }
  }, [sessionReady, sessionLocationGid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadAvailableMonths(selectedLocation?.locationId);
  }, [selectedLocation?.locationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // availableMonths から年・月リストを導出
  const availableYears = useMemo(() => {
    const set = new Set(
      availableMonths.map((ym) => parseInt(ym.split("-")[0], 10)).filter(Boolean)
    );
    return Array.from(set).sort((a, b) => b - a);
  }, [availableMonths]);

  const availableMonthsForYear = useMemo(() => {
    const set = new Set(
      availableMonths
        .filter((ym) => parseInt(ym.split("-")[0], 10) === selectedYear)
        .map((ym) => parseInt(ym.split("-")[1], 10))
        .filter(Boolean)
    );
    return Array.from(set).sort((a, b) => b - a);
  }, [availableMonths, selectedYear]);

  useEffect(() => {
    if (availableYears.length === 0) return;
    if (!availableYears.includes(selectedYear)) {
      const y = availableYears[0];
      setSelectedYear(y);
      const months = availableMonths
        .filter((ym) => parseInt(ym.split("-")[0], 10) === y)
        .map((ym) => parseInt(ym.split("-")[1], 10))
        .filter(Boolean)
        .sort((a, b) => b - a);
      if (months.length > 0) setSelectedMonth(months[0]);
      return;
    }
    if (availableMonthsForYear.length > 0 && !availableMonthsForYear.includes(selectedMonth)) {
      setSelectedMonth(availableMonthsForYear[0]);
    }
  }, [availableYears, availableMonthsForYear, selectedYear, selectedMonth, availableMonths]);

  const loadMonthRows = useCallback(async (locationId, year, month) => {
    if (!locationId || !year || !month) {
      setMonthRows([]);
      return;
    }
    setMonthRowsLoading(true);
    setMonthRowsError("");
    try {
      const res = await getMonthRows({ locationId, year, month });
      setMonthRows(res?.rows ?? []);
    } catch (e) {
      setMonthRows([]);
      setMonthRowsError(toUserMessage(e?.message) || "日別集計の取得に失敗しました");
    } finally {
      setMonthRowsLoading(false);
    }
  }, []);

  const fetchPreviewForDate = useCallback(
    async ({ date, inspection = false, openStep = "preview", refreshMonthRows = false }) => {
      if (!selectedLocation) return false;
      hideSettlementIssueConfirmModals();
      setLoading(true);
      setError("");
      setIsInspection(inspection);
      try {
        const res = await previewSettlement({
          locationId: selectedLocation.locationId,
          locationName: selectedLocation.locationName,
          targetDate: date,
        });
        setTargetDate(date);
        setPreview(res.preview);
        setPreviewLoadedAt(Date.now());
        setStep(openStep);
        if (refreshMonthRows) {
          await loadMonthRows(selectedLocation.locationId, selectedYear, selectedMonth);
        }
        return true;
      } catch (e) {
        setError(toUserMessage(e?.message) || "精算内容の取得に失敗しました");
        return false;
      } finally {
        setLoading(false);
      }
    },
    [selectedLocation, selectedYear, selectedMonth, loadMonthRows]
  );

  const handleCreate = useCallback(async () => {
    if (!selectedLocation || !preview) return;
    setLoading(true);
    setError("");
    try {
      const res = await createSettlement({
        locationId: selectedLocation.locationId,
        locationName: selectedLocation.locationName,
        targetDate,
        // サーバーは DB の Location.printMode を正とする。欠落時は order_based で送る（互換用）。
        printMode: selectedLocation.printMode ?? "order_based",
        isInspection,
      });
      setSettlementResult(res);
      hideSettlementIssueConfirmModals();
      setStep("done");
    } catch (e) {
      setError(toUserMessage(e?.message) || "精算の実行に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation, preview, targetDate, isInspection]);

  // 確定のあとに数が変わった日の再確定（前の確定値は履歴に残る）
  const handleReconfirm = useCallback(async () => {
    if (!selectedLocation) return;
    setLoading(true);
    setError("");
    try {
      const res = await createSettlement({
        locationId: selectedLocation.locationId,
        locationName: selectedLocation.locationName,
        targetDate,
        printMode: selectedLocation.printMode ?? "order_based",
        isInspection: false,
        reconfirm: true,
      });
      setIsInspection(false);
      setSettlementResult(res);
      hideSettlementIssueConfirmModals();
      setStep("done");
    } catch (e) {
      setError(toUserMessage(e?.message) || "再確定に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation, targetDate]);

  const handleOpenDailyRow = useCallback(async (row) => {
    const d = String(row?.targetDate || "").trim();
    if (!d || !selectedLocation) return;
    hideSettlementIssueConfirmModals();
    if (row?.settlement) {
      setSelectedHistoryItem(row.settlement);
      setStep("historyDetail");
      return;
    }
    setLoading(true);
    setError("");
    setIsInspection(false);
    try {
      const res = await previewSettlement({
        locationId: selectedLocation.locationId,
        locationName: selectedLocation.locationName,
        targetDate: d,
      });
      setTargetDate(d);
      setPreview(res.preview);
      setPreviewLoadedAt(Date.now());
      setStep("preview");
    } catch (e) {
      setError(toUserMessage(e?.message) || "日別明細の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation]);

  const handleRecalculate = useCallback(async () => {
    if (!selectedLocation) return;
    setLoading(true);
    setError("");
    try {
      const res = await recalculateSettlement({
        locationId: selectedLocation.locationId,
        locationName: selectedLocation.locationName,
        targetDate,
      });
      // 確定済みの日は、サーバーが確定値を返す（confirmed: true）。確定のあとに数が変わっていれば
      // changedSinceConfirm と今の値（livePreview）も返るので、再確定のボタンを出す
      setPreview(
        res?.confirmed
          ? {
              ...res.preview,
              confirmedFromDb: true,
              changedSinceConfirm: !!res.changedSinceConfirm,
              liveTotal: res.livePreview?.total ?? null,
            }
          : res.preview,
      );
      setPreviewLoadedAt(Date.now());
    } catch (e) {
      setError(toUserMessage(e?.message) || "再集計に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation, targetDate]);

  useEffect(() => {
    loadMonthRows(selectedLocation?.locationId, selectedYear, selectedMonth);
  }, [selectedLocation?.locationId, selectedYear, selectedMonth, loadMonthRows]);

  // 初回は当日の精算画面を自動表示（月別一覧の読み込み後にプレビュー＝API競合を避ける）
  useEffect(() => {
    if (!selectedLocation || initialPreviewLoaded || monthRowsLoading) return;
    const t = todayStr();
    const timer = setTimeout(() => {
      fetchPreviewForDate({
        date: t,
        inspection: false,
        openStep: "preview",
        refreshMonthRows: true,
      }).finally(() => setInitialPreviewLoaded(true));
    }, 300);
    return () => clearTimeout(timer);
  }, [selectedLocation, initialPreviewLoaded, monthRowsLoading, fetchPreviewForDate]);

  if (step === "main") {
    return (
      <MainView
        locations={locations}
        selectedLocation={selectedLocation}
        selectedYear={selectedYear}
        selectedMonth={selectedMonth}
        availableYears={availableYears}
        availableMonthsForYear={availableMonthsForYear}
        dailyRows={monthRows}
        dailyLoading={monthRowsLoading || monthsLoading}
        dailyError={monthRowsError || monthsError}
        loading={loading}
        error={error}
        locationLoadError={locationLoadError}
        onSelectLocation={(loc) => setSelectedLocation(loc)}
        onSelectYear={(year) => {
          setSelectedYear(year);
          const months = availableMonths
            .filter((ym) => parseInt(ym.split("-")[0], 10) === year)
            .map((ym) => parseInt(ym.split("-")[1], 10))
            .filter(Boolean)
            .sort((a, b) => b - a);
          if (months.length > 0) {
            setSelectedMonth(months[0]);
            setTargetDate(`${year}-${String(months[0]).padStart(2, "0")}-01`);
          } else {
            setTargetDate(`${year}-${String(selectedMonth).padStart(2, "0")}-01`);
          }
        }}
        onSelectMonth={(month) => {
          setSelectedMonth(month);
          setTargetDate(`${selectedYear}-${String(month).padStart(2, "0")}-01`);
        }}
        onOpenDailyRow={handleOpenDailyRow}
        onRetryLocations={loadLocations}
        onRetryDaily={() => {
          loadAvailableMonths(selectedLocation?.locationId);
          loadMonthRows(selectedLocation?.locationId, selectedYear, selectedMonth);
        }}
        onBackFromHistory={() => {
          hideSettlementIssueConfirmModals();
          setError("");
          setStep("preview");
        }}
        setError={setError}
      />
    );
  }

  if (step === "preview") {
    return (
      <PreviewView
        preview={preview}
        targetDate={targetDate}
        canPrevDay={targetDate > "2020-01-01"}
        canNextDay={targetDate < todayStr()}
        loading={loading}
        error={error}
        loadedAt={previewLoadedAt}
        onPickDate={(d) => fetchPreviewForDate({ date: d, inspection: false, openStep: "preview" })}
        onRecalculate={handleRecalculate}
        onReconfirm={handleReconfirm}
        onPrepareInspectionIssue={() => {
          setIsInspection(true);
          setError("");
          setStep("confirm");
        }}
        onPrepareSettleIssue={() => {
          setIsInspection(false);
          setError("");
          setStep("confirm");
        }}
        onBackToHistory={() => {
          hideSettlementIssueConfirmModals();
          setStep("main");
        }}
      />
    );
  }

  if (step === "confirm") {
    return (
      <SettlementIssueConfirmView
        preview={preview}
        printMode={selectedLocation?.printMode ?? "order_based"}
        isInspection={isInspection}
        loading={loading}
        error={error}
        onExecute={handleCreate}
        onBack={() => {
          if (loading) return;
          setError("");
          setIsInspection(false);
          setStep("preview");
        }}
      />
    );
  }

  if (step === "done") {
    return (
      <DoneView
        result={settlementResult}
        isInspection={isInspection}
        targetDateYmd={targetDate}
        onBack={() => {
          hideSettlementIssueConfirmModals();
          setStep("main");
          setPreview(null);
          setSettlementResult(null);
        }}
      />
    );
  }

  if (step === "historyDetail") {
    return (
      <HistoryDetailView
        item={selectedHistoryItem}
        onBack={() => setStep("main")}
      />
    );
  }

  return null;
}

// ── メイン画面 ────────────────────────────────────────────────────────────────
function MainView({
  locations,
  selectedLocation,
  selectedYear,
  selectedMonth,
  availableYears,
  availableMonthsForYear,
  dailyRows,
  dailyLoading,
  dailyError,
  loading,
  error,
  locationLoadError,
  onSelectLocation,
  onSelectYear,
  onSelectMonth,
  onOpenDailyRow,
  onRetryLocations,
  onRetryDaily,
  onBackFromHistory,
  setError,
}) {
  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);
  const [locMenuOpen, setLocMenuOpen] = useState(false);

  return (
    <s-page heading="精算">
      <s-stack
        gap="none"
        blockSize="100%"
        inlineSize="100%"
        minBlockSize="0"
        style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
      >
        {/* POS Stock 入庫固定フッターと同型の枠線。リストとの境は下の s-divider */}
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
            {locationLoadError ? (
              <s-stack gap="small">
                <s-text tone="critical">{locationLoadError}</s-text>
                <s-button kind="secondary" onClick={onRetryLocations} loading={loading}>
                  再読み込み
                </s-button>
              </s-stack>
            ) : (
              <s-stack gap="small">
                {/* 1行目のみ：ロケーション名（左）＋ 固定幅の年・月ボタン（右・同行） */}
                <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" style={{ width: "100%" }}>
                  <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                    {locations.length > 1 ? (
                      <s-button
                        kind="secondary"
                        style={{ width: "100%", maxInlineSize: "100%" }}
                        onClick={() => {
                          setYearMenuOpen(false);
                          setMonthMenuOpen(false);
                          setLocMenuOpen((v) => !v);
                        }}
                      >
                        {selectedLocation?.locationName ?? "ロケーションを選ぶ"} ▾
                      </s-button>
                    ) : selectedLocation ? (
                      <s-text emphasis="bold" size="small">{selectedLocation.locationName}</s-text>
                    ) : loading ? (
                      <s-text tone="subdued" size="small">ロケーションを読み込み中…</s-text>
                    ) : (
                      <s-stack gap="small">
                        <s-text tone="subdued" size="small">ロケーションが見つかりません</s-text>
                        <s-button kind="plain" onClick={onRetryLocations}>再読込</s-button>
                      </s-stack>
                    )}
                  </s-box>
                  <s-stack direction="inline" gap="small" alignItems="center" justifyContent="end" style={{ flex: "0 0 auto" }}>
                    <s-box style={{ inlineSize: "5.25rem", flex: "0 0 5.25rem" }}>
                      <s-button
                        kind="secondary"
                        style={{ width: "100%", maxInlineSize: "100%" }}
                        onClick={() => {
                          setMonthMenuOpen(false);
                          setLocMenuOpen(false);
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
                          setLocMenuOpen(false);
                          setMonthMenuOpen((v) => !v);
                        }}
                      >
                        {selectedMonth}月
                      </s-button>
                    </s-box>
                  </s-stack>
                </s-stack>
                {/* 上の行の直下：ロケーションの選択リスト（POS には s-select が無いのでボタンで選ぶ） */}
                {locMenuOpen && locations.length > 1 ? (
                  <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                    <s-stack gap="small">
                      {locations.map((loc) => (
                        <s-button
                          key={`loc-${loc.locationId}`}
                          kind={loc.locationId === selectedLocation?.locationId ? "primary" : "secondary"}
                          onClick={() => {
                            onSelectLocation(loc);
                            setLocMenuOpen(false);
                            setError("");
                          }}
                        >
                          {loc.locationName}
                        </s-button>
                      ))}
                    </s-stack>
                  </s-box>
                ) : null}
                {/* 上の行の直下：年または月の選択リスト（同行には出さない） */}
                {yearMenuOpen ? (
                  <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                    <s-stack
                      direction="inline"
                      gap="small"
                      style={{ flexWrap: "wrap", width: "100%", alignItems: "center" }}
                    >
                      {availableYears.length === 0 ? (
                        <s-text tone="subdued" fontSize="small">選べる年がありません</s-text>
                      ) : (
                        availableYears.map((y) => (
                          <s-button
                            key={`year-${y}`}
                            kind={y === selectedYear ? "primary" : "secondary"}
                            style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                            onClick={() => {
                              onSelectYear(y);
                              setYearMenuOpen(false);
                              setError("");
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
                      {availableMonthsForYear.length === 0 ? (
                        <s-text tone="subdued" fontSize="small">選べる月がありません</s-text>
                      ) : (
                        availableMonthsForYear.map((m) => (
                          <s-button
                            key={`month-${m}`}
                            kind={m === selectedMonth ? "primary" : "secondary"}
                            style={{ flex: "0 0 auto", width: "auto", maxInlineSize: "none" }}
                            onClick={() => {
                              onSelectMonth(m);
                              setMonthMenuOpen(false);
                              setError("");
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

        {/* POS Stock の LossHistoryList と同型：外側 base パディング、行は small + 行下 divider */}
        <s-scroll-box
          blockSize="auto"
          maxBlockSize="100%"
          minBlockSize="0"
          style={{ flex: "1 1 0", minHeight: 0 }}
        >
          <s-box padding="base">
            <s-stack gap="base">
              {dailyLoading ? (
                <s-text tone="subdued" size="small">読み込み中…</s-text>
              ) : dailyError ? (
                <s-stack gap="small">
                  <s-text tone="critical">{dailyError}</s-text>
                  <s-button kind="secondary" onClick={onRetryDaily}>再読み込み</s-button>
                </s-stack>
              ) : dailyRows.length === 0 ? (
                <s-text tone="subdued" size="small">表示できる日がありません</s-text>
              ) : (
                <s-stack gap="base">
                  {dailyRows.map((row) => (
                    <s-clickable
                      key={row.targetDate}
                      onClick={() => {
                        if (loading || dailyLoading) return;
                        onOpenDailyRow(row);
                      }}
                    >
                      <s-box padding="small">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                          <s-text
                            emphasis="bold"
                            size="small"
                            style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                          >
                            {formatYmdSlash(row.targetDate)}
                          </s-text>
                          <s-text fontWeight="bold" size="small" style={{ whiteSpace: "nowrap" }}>
                            ¥{Number(row.netSales).toLocaleString()}
                          </s-text>
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

        {error ? (
          <s-box padding="base" paddingBlockStart="none">
            <s-text tone="critical">{error}</s-text>
          </s-box>
        ) : null}

        <s-divider />

        <FixedFooterNavBar
          centerAlignWithButtons
          leftLabel="戻る"
          onLeft={() => {
            setError("");
            onBackFromHistory();
          }}
          leftDisabled={!selectedLocation || loading || dailyLoading}
          rightLabel={loading ? "読込中.." : dailyLoading ? "更新中.." : "更新"}
          onRight={onRetryDaily}
          rightDisabled={!selectedLocation || loading || dailyLoading}
        />
      </s-stack>
    </s-page>
  );
}

// ── 精算画面（集計結果） ─────────────────────────────────────────────────────
function PreviewView({
  preview,
  targetDate,
  canPrevDay,
  canNextDay,
  loading,
  error,
  loadedAt,
  onPickDate,
  onRecalculate,
  onReconfirm,
  onPrepareInspectionIssue,
  onPrepareSettleIssue,
  onBackToHistory,
}) {
  if (!preview) {
    return (
      <s-page heading="精算">
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
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
              <s-button kind="secondary" disabled={!canPrevDay || loading} onClick={() => onPickDate(addDays(targetDate, -1))}>
                前日
              </s-button>
              <s-text type="strong">{formatYmdWithWeekday(targetDate)}</s-text>
              <s-button kind="secondary" disabled={!canNextDay || loading} onClick={() => onPickDate(addDays(targetDate, 1))}>
                翌日
              </s-button>
            </s-stack>
          </s-box>
          <s-divider />
          <s-scroll-box blockSize="auto" maxBlockSize="100%" minBlockSize="0" style={{ flex: "1 1 0", minHeight: 0 }}>
            <s-box padding="base">
              <s-stack gap="base">
                <SettlementTopNotices loading={loading} error={error} />
                {!loading && !error ? (
                  <s-text tone="subdued" size="small">精算の数を読み込み中…</s-text>
                ) : null}
                {!loading ? (
                  <s-button kind="secondary" onClick={() => onPickDate(targetDate)}>
                    再読み込み
                  </s-button>
                ) : null}
              </s-stack>
            </s-box>
          </s-scroll-box>
          <s-divider />
          <FixedFooterNavBar
            centerAlignWithButtons
            leftLabel="履歴一覧"
            onLeft={onBackToHistory}
            leftDisabled={loading}
            middleLabel="点検"
            onMiddle={onPrepareInspectionIssue}
            middleDisabled
            rightLabel="精算"
            onRight={onPrepareSettleIssue}
            rightTone="success"
            rightDisabled
          />
        </s-stack>
      </s-page>
    );
  }

  // 見出しで区切る形（案B, 2026-11-23）。数は preview のまま、並べ方と書き方だけ。
  // 店名と日付は上の帯に出ているので、表の中には繰り返さない。
  const discount = formatDeduction(preview.discounts);
  const refund = formatDeduction(preview.refundTotal);
  const salesLines = [
    { key: "total", label: "総売上", value: formatYen(preview.total), strong: true },
    { key: "net", label: "純売上", value: formatYen(preview.netSales), indent: true },
    { key: "tax", label: "消費税", value: formatYen(preview.tax), indent: true },
    { key: "discount", label: "割引", value: discount.text, tone: discount.tone },
    { key: "refund", label: "返金", value: refund.text, tone: refund.tone },
  ];
  if (Number(preview.voucherChangeAmount) > 0) {
    salesLines.push({
      key: "voucherChange",
      label: "商品券釣有り差額",
      value: formatYen(preview.voucherChangeAmount),
    });
  }
  // 売上に含めない送料等（支払方法別には入っている分。総売上には入れていない）
  if (Number(preview.nonSalesFeeTotal ?? 0) !== 0) {
    salesLines.push({
      key: "nonSalesFee",
      label: "売上に含めない送料等",
      value: formatYen(preview.nonSalesFeeTotal),
    });
  }

  const countLabel = `売上 ${Number(preview.orderCount ?? 0)}件　・　返金 ${Number(preview.refundCount ?? 0)}件`;
  const itemCountLabel = `${Number(preview.itemCount ?? 0)}点`;

  /** 納金（現金セクションの net − refund − 商品券の釣銭） */
  const cashDepositRows = [];
  const voucherCashDeduction = Math.max(0, Math.round(Number(preview.voucherChangeBreakdown?.cashDepositDeduction ?? 0)));
  /** 支払方法 | 件数 | 金額（返金は字下げした「返金」の行・赤） */
  const paymentLines = [];
  if (preview.paymentSections?.length > 0) {
    for (const section of preview.paymentSections) {
      const methodLabel = section.label ?? section.gateway ?? "-";
      if (isCashPaymentSection(section)) {
        // 商品券の釣銭をレジの現金から渡した分は、最初の現金の行から引く（商品券設定「納金金額から引く」）
        const voucherDeduct = cashDepositRows.length === 0 ? voucherCashDeduction : 0;
        const deposit = Math.round(Number(section.net ?? 0) - Number(section.refund ?? 0) - voucherDeduct);
        cashDepositRows.push({
          key: `deposit-${section.gateway}-${cashDepositRows.length}`,
          label: methodLabel,
          value: formatYen(deposit),
        });
      }
      paymentLines.push({
        key: `${section.gateway}-sale`,
        label: methodLabel,
        count: `${Number(section.txCount ?? 0)}件`,
        amount: formatYen(section.net ?? 0),
      });
      if (Number(section.refund) > 0) {
        const r = formatDeduction(section.refund);
        paymentLines.push({
          key: `${section.gateway}-refund`,
          label: "返金",
          count: `${Number(section.refundCount ?? 0)}件`,
          amount: r.text,
          tone: r.tone,
          indent: true,
        });
      }
    }
  }

  if (voucherCashDeduction > 0) {
    if (cashDepositRows.length === 0) {
      // 現金の売上が無い日でも、釣銭を現金で渡していれば納金はマイナスになる
      cashDepositRows.push({ key: "deposit-cash-voucher-only", label: "現金", value: `¥${(-voucherCashDeduction).toLocaleString()}` });
    }
    cashDepositRows.push({
      key: "deposit-voucher-change",
      label: "うち商品券の釣銭",
      value: `▲¥${voucherCashDeduction.toLocaleString()}`,
    });
  }

  const eventRows = [];
  for (const ev of preview.appliedSpecialRefundEvents ?? []) {
    eventRows.push({
      key: `sr-${ev.id}`,
      label: `${ev.sourceOrderName ?? "-"}（${specialRefundEventTypeLabel(ev.eventType)}）`,
      value: formatYen(ev.amount),
    });
  }
  for (const ev of preview.appliedVoucherAdjustments ?? []) {
    eventRows.push({
      key: `va-${ev.id}`,
      label: `${ev.sourceOrderName ?? "-"}（商品券釣有り）`,
      value: formatYen(ev.voucherChangeAmount),
    });
  }
  // 同じ注文に自動判定と手入力の両方があり、判定優先順位で片方を外した額（商品券設定）
  const vb = preview.voucherChangeBreakdown;
  if (vb && Number(vb.skippedAutoAmount) > 0) {
    eventRows.push({
      key: "va-skipped-auto",
      label: "商品券釣有り：手入力を優先して外した自動の分",
      value: `¥${Number(vb.skippedAutoAmount).toLocaleString()}`,
    });
  }
  if (vb && Number(vb.skippedManualAmount) > 0) {
    eventRows.push({
      key: "va-skipped-manual",
      label: "商品券釣有り：自動を優先して外した手入力の分",
      value: `¥${Number(vb.skippedManualAmount).toLocaleString()}`,
    });
  }

  return (
    <s-page heading="精算">
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
                <s-text type="strong">
                  {preview.locationName ?? "-"}
                </s-text>
              </s-box>
              <s-box style={{ flex: "0 0 auto" }}>
                <s-button kind="secondary" onClick={onRecalculate} disabled={loading}>
                  {loading ? "更新中.." : "更新"}
                </s-button>
              </s-box>
            </s-stack>
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
              <s-button kind="secondary" disabled={!canPrevDay || loading} onClick={() => onPickDate(addDays(targetDate, -1))}>
                前日
              </s-button>
              <s-stack gap="none" alignItems="center">
                <s-text type="strong">{formatYmdWithWeekday(targetDate)}</s-text>
                <s-text type="small" color="subdued">
                  {loading ? "読み込み中…" : loadedAt ? `${formatJstHm(loadedAt)} 時点の数` : ""}
                </s-text>
              </s-stack>
              <s-button kind="secondary" disabled={!canNextDay || loading} onClick={() => onPickDate(addDays(targetDate, 1))}>
                翌日
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>

        <s-divider />

        <s-scroll-box blockSize="auto" maxBlockSize="100%" minBlockSize="0" style={{ flex: "1 1 0", minHeight: 0 }}>
          <s-box padding="base">
            <s-stack gap="base">
              {/*
                大事な案内は一覧の「上」に出す（下に出すと iPhone ではスクロールしないと気づけない）。
                確定済み・確定のあとに数が変わった・返金処理中などの案内を足すときも、ここに置く。
              */}
              <SettlementTopNotices loading={loading} error={error} />

              {/* 確定済み・再確定・承認待ち・返金処理中・支払方法の行に入れられなかった返金（#93 系。#98 の決まりで表の上に置く） */}
              {/* 特殊返金の返金方法が支払方法マスタに無い等（精算は確定できる。合計は正しい） */}
              {(preview.unmatchedRefundMethods ?? []).length > 0 ? (
                <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack gap="small">
                    <s-text type="strong" tone="caution">
                      支払方法の行に入れられなかった特殊返金があります
                    </s-text>
                    {preview.unmatchedRefundMethods.map((w, i) => (
                      <s-text key={`unmatched-${i}`} tone="caution" type="small">
                        {w.message}
                      </s-text>
                    ))}
                    <s-text tone="subdued" type="small">
                      合計は正しいまま精算できます。管理画面の「支払方法」に登録すると、次の更新から正しい行に入ります。
                    </s-text>
                  </s-stack>
                </s-box>
              ) : null}
              {preview.awaitingApprovalSpecialRefunds?.length ? (
                <s-text tone="caution">
                  {preview.awaitingApprovalWarning ??
                    `管理者の承認待ちの返金方法変更が ${preview.awaitingApprovalSpecialRefunds.length} 件あります。承認されるまで上の金額に入っていません。`}
                </s-text>
              ) : null}
              {preview.pendingSpecialRefundOrderLabels?.length ? (
                <s-text tone="caution">
                  返金処理中の特殊返金があります（注文: {preview.pendingSpecialRefundOrderLabels.slice(0, 5).join("、")}）。この返金は上の金額に入っていません。点検は出せますが、精算（確定）の前に特殊返金の「返金を確かめる」を押してください（自動の確定をオンにした店では、数分たつと自動で読み直します）。
                </s-text>
              ) : null}
              {preview.confirmedFromDb ? (
                <s-text tone="subdued">
                  この日は精算を確定済みです。確定したときの値を表示しています。
                </s-text>
              ) : null}
              {preview.confirmedFromDb && preview.changedSinceConfirm ? (
                <s-stack gap="small">
                  <s-text tone="caution">
                    確定したあとに数が変わりました（今の総売上 ¥{Number(preview.liveTotal ?? 0).toLocaleString()}）。再確定すると今の数で確定し直し、前の確定値は履歴に残ります。
                  </s-text>
                  <s-button kind="secondary" onClick={onReconfirm} disabled={loading}>
                    {loading ? "再確定中.." : "今の数で再確定する"}
                  </s-button>
                </s-stack>
              ) : null}

              <s-box>
                <SummaryHeading first>売上</SummaryHeading>
                {salesLines.map((l) => (
                  <SummaryLine
                    key={l.key}
                    label={l.label}
                    value={l.value}
                    strong={l.strong}
                    indent={l.indent}
                    tone={l.tone}
                  />
                ))}

                <SummaryHeading>件数</SummaryHeading>
                <SummaryLine label={countLabel} value={itemCountLabel} />

                {paymentLines.length > 0 ? (
                  <>
                    <SummaryHeading>支払方法別</SummaryHeading>
                    {paymentLines.map((l) => (
                      <PaymentLine
                        key={l.key}
                        label={l.label}
                        count={l.count}
                        amount={l.amount}
                        indent={l.indent}
                        tone={l.tone}
                      />
                    ))}
                  </>
                ) : null}

                {cashDepositRows.length > 0 ? (
                  <>
                    <SummaryHeading>納金</SummaryHeading>
                    {cashDepositRows.map((l) => (
                      <SummaryLine key={l.key} label={l.label} value={l.value} strong tone="success" />
                    ))}
                  </>
                ) : null}

                {eventRows.length > 0 ? (
                  <>
                    <SummaryHeading>返金方法変更・商品券釣銭登録</SummaryHeading>
                    {eventRows.map((l) => (
                      <SummaryLine key={l.key} label={l.label} value={l.value} />
                    ))}
                  </>
                ) : null}
              </s-box>
            </s-stack>
          </s-box>
        </s-scroll-box>

        <s-divider />

        <FixedFooterNavBar
          centerAlignWithButtons
          leftLabel="履歴一覧"
          onLeft={onBackToHistory}
          leftDisabled={loading}
          middleLabel="点検"
          onMiddle={onPrepareInspectionIssue}
          middleDisabled={loading}
          rightLabel="精算"
          onRight={onPrepareSettleIssue}
          rightTone="success"
          rightDisabled={loading}
        />
      </s-stack>
    </s-page>
  );
}

/**
 * 精算画面の上に出す案内（読み込み中・エラー）。
 * s-banner は POS にある部品。文は見出し（heading）に入れる（端末によって本文が畳まれることがあるため）。
 */
function SettlementTopNotices({ loading, error, busyLabel = "読み込み中です。少しお待ちください。" }) {
  if (!loading && !error) return null;
  return (
    <s-stack gap="small">
      {loading ? <s-banner tone="info" heading={busyLabel} /> : null}
      {!loading && error ? <s-banner tone="critical" heading={error} /> : null}
    </s-stack>
  );
}

/**
 * 点検／精算の発行確認。画面ごと切り替える（重ね表示の s-modal は使わない）。
 * 案内・確認の中身・発行ボタンがスクロールなしで見えるよう、上から 何をするか → 結果の案内 → 中身 の順に置く。
 */
function SettlementIssueConfirmView({ preview, printMode, isInspection, loading, error, onExecute, onBack }) {
  const printModeLabel =
    printMode === "cloudprnt_direct"
      ? "プリンタへ直接印字"
      : "注文経由で印字（精算用の注文を作ります）";

  const rows = [
    { label: "ロケーション", value: preview?.locationName ?? "-" },
    { label: "対象日", value: formatYmdSlash(preview?.targetDate ?? "-") },
    { label: "総売上", value: `¥${Number(preview?.total ?? 0).toLocaleString()}`, valueBold: true },
    { label: "件数", value: `${preview?.orderCount ?? 0}件` },
  ];
  if (!isInspection) rows.push({ label: "印字", value: printModeLabel });

  const title = isInspection ? "点検レシートを発行します" : "精算を確定して、精算レシートを発行します";
  const note = isInspection
    ? "点検ではこの日の精算は確定しません。"
    : "確定すると、この日の数が精算履歴に残ります。";

  return (
    <s-page heading={isInspection ? "点検レシートの発行" : "精算の発行"}>
      <s-stack
        gap="none"
        blockSize="100%"
        inlineSize="100%"
        minBlockSize="0"
        style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
      >
        <s-scroll-box blockSize="auto" maxBlockSize="100%" minBlockSize="0" style={{ flex: "1 1 0", minHeight: 0 }}>
          <s-box padding="base">
            <s-stack gap="base">
              <SettlementTopNotices loading={loading} error={error} busyLabel="発行中です。画面を閉じずにお待ちください。" />
              <s-text fontWeight="bold">{title}</s-text>
              <s-text tone="subdued" size="small">{note}</s-text>
              <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="none">
                  {rows.map((row, i, arr) => (
                    <SummaryRow
                      key={row.label}
                      label={row.label}
                      value={row.value}
                      valueBold={row.valueBold}
                      divider={i < arr.length - 1}
                    />
                  ))}
                </s-stack>
              </s-box>
            </s-stack>
          </s-box>
        </s-scroll-box>
        <s-divider />
        <FixedFooterNavBar
          centerAlignWithButtons
          leftLabel="戻る"
          onLeft={onBack}
          leftDisabled={loading}
          rightLabel={loading ? "発行中.." : "発行する"}
          onRight={onExecute}
          rightTone="success"
          rightDisabled={loading || !preview}
        />
      </s-stack>
    </s-page>
  );
}

// ── 完了画面 ──────────────────────────────────────────────────────────────────
function DoneView({ result, isInspection, targetDateYmd, onBack }) {
  const isOrderBased = result?.printMode === "order_based";
  const doneTargetDate = result?.preview?.targetDate ?? result?.targetDate ?? targetDateYmd ?? "-";
  const doneTotal = result?.preview?.total;
  const [printBusy, setPrintBusy] = useState(false);
  const [printMsg, setPrintMsg] = useState("");
  const [printFlags, setPrintFlags] = useState({
    preferPrintingApi: false,
    settlementPrintingApiEnabled: false,
  });
  const [flagsLoaded, setFlagsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPrintSettings()
      .then((s) => {
        if (!cancelled) {
          setPrintFlags({
            preferPrintingApi: !!s.preferPrintingApi,
            settlementPrintingApiEnabled: !!s.settlementPrintingApiEnabled,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setFlagsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showPrintingApi =
    flagsLoaded && !!printFlags.settlementPrintingApiEnabled && !!result?.settlementId;
  const preferNew = showPrintingApi && !!printFlags.preferPrintingApi;

  const handlePrintingApi = async () => {
    if (!result?.settlementId) {
      setPrintMsg("精算 ID が無いため Printing API を実行できません");
      return;
    }
    setPrintBusy(true);
    setPrintMsg("");
    try {
      const res = await printSettlementReceipt(result.settlementId);
      if (res.ok) {
        setPrintMsg(res.usedDialog ? "印刷ダイアログを開きました" : "プリンタへ送信しました");
      } else {
        setPrintMsg(res.error || "印字に失敗しました");
      }
    } catch (e) {
      setPrintMsg(toUserMessage(e?.message) || "印字に失敗しました");
    } finally {
      setPrintBusy(false);
    }
  };

  const printingApiBox = showPrintingApi ? (
    <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack gap="small">
        <s-text fontWeight="bold">
          {preferNew ? "Shopify Printing API（推奨）" : "Shopify Printing API（代替）"}
        </s-text>
        {!preferNew ? (
          <s-text tone="caution" fontSize="small">
            ※ 旧経路で印字済みの場合は押さないでください（二重印字になります）。
          </s-text>
        ) : null}
        <s-button
          variant={preferNew ? "primary" : "secondary"}
          onClick={handlePrintingApi}
          disabled={printBusy}
        >
          {printBusy ? "送信中…" : "Printing API で印字"}
        </s-button>
        {printMsg ? <s-text tone="subdued">{printMsg}</s-text> : null}
      </s-stack>
    </s-box>
  ) : null;

  const legacyBox = (() => {
    if (isInspection) {
      return (
        <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
          <s-stack gap="small">
            <s-text fontWeight="bold">
              {preferNew ? "点検レシート（従来）" : "点検レシート"}
            </s-text>
            <s-text tone="subdued">
              点検では Shopify 上に精算用の注文は作りません。保存した内容をレシートテンプレートで印刷してください。
            </s-text>
            {preferNew ? (
              <s-text tone="caution" fontSize="small">
                ※ Printing API で印字した場合は、こちらでは再印字しないでください（二重印字）。
              </s-text>
            ) : null}
          </s-stack>
        </s-box>
      );
    }
    if (isOrderBased && result?.sourceOrderName) {
      return (
        <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
          <s-stack gap="small">
            <s-text fontWeight="bold">
              {preferNew ? "注文経由印字（従来・代替）" : "注文経由印字"}
            </s-text>
            <s-text tone="subdued">
              精算注文 <s-text fontWeight="bold">{result.sourceOrderName}</s-text> を作成しました。
            </s-text>
            <s-text tone="subdued" fontSize="small">
              POS の注文一覧からこの注文を開き、レシートを印刷してください。
            </s-text>
            {showPrintingApi ? (
              <s-text tone="caution" fontSize="small">
                ※ Printing API と両方で印字すると二重になります。どちらか一方だけ使ってください。
              </s-text>
            ) : null}
          </s-stack>
        </s-box>
      );
    }
    if (isOrderBased && !result?.sourceOrderName && result?.settlementOrderSkipped === true) {
      // 印字設定で「精算注文を作成」が OFF の店。失敗ではないので赤字にしない
      return (
        <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
          <s-stack gap="small">
            <s-text fontWeight="bold">精算を記録しました（精算注文は作っていません）</s-text>
            <s-text tone="subdued" fontSize="small">
              管理画面の印字設定で「精算注文を作成」が OFF のため、Shopify の精算注文は作っていません。
              {showPrintingApi ? " レシートは上の Printing API の印字を使ってください。" : ""}
            </s-text>
          </s-stack>
        </s-box>
      );
    }
    if (isOrderBased && !result?.sourceOrderName) {
      return (
        <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
          <s-stack gap="small">
            <s-text fontWeight="bold" tone="critical">
              注文番号を取得できませんでした
            </s-text>
            <s-text tone="subdued" fontSize="small">
              精算は記録しましたが、精算注文の名前が返っていません。管理画面の Shopify 注文一覧で tag SETTLEMENT
              の注文ができているかを確かめてください。無ければ、同じ日・同じ店の精算をもう一度発行すると、その日の精算注文を探して、無ければ作ります（精算の記録は二重になりません）。
            </s-text>
          </s-stack>
        </s-box>
      );
    }
    return (
      <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
        <s-stack gap="small">
          <s-text fontWeight="bold">
            {preferNew ? "CloudPRNT 直印字（従来・代替）" : "CloudPRNT 直印字"}
          </s-text>
          <s-text tone="subdued">精算データを保存しました。プリンタから印刷されます。</s-text>
          {showPrintingApi ? (
            <s-text tone="caution" fontSize="small">
              ※ Printing API と両方で印字すると二重になります。どちらか一方だけ使ってください。
            </s-text>
          ) : null}
          {result?.settlementId ? (
            <>
              <s-text tone="subdued" fontSize="small">
                印字用データは以下のURLで取得できます。実機確認時に CloudPRNT 対応プリンタのポーリング先に設定してください。
              </s-text>
              <s-text fontSize="small" fontWeight="bold">
                {getAppUrl()}/api/settlements/{result.settlementId}/print-payload
              </s-text>
            </>
          ) : null}
        </s-stack>
      </s-box>
    );
  })();

  return (
    <s-page heading="発行完了">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text fontWeight="bold">
              {isInspection ? "点検レシートを保存しました" : "精算レシートを保存しました"}
            </s-text>
            {result?.reconfirmed === true ? (
              <s-text tone="subdued">今の数で確定し直しました。前の確定値は履歴に残っています。</s-text>
            ) : null}
            {result?.reconfirmed === false ? (
              <s-text tone="subdued">確定値と今の数は同じでした。確定値はそのままです。</s-text>
            ) : null}
            {result?.warning ? <s-text tone="caution">{result.warning}</s-text> : null}

            {/* preferPrintingApi ON → Printing API を primary、旧経路は secondary＋警告 */}
            {preferNew ? (
              <>
                {printingApiBox}
                {legacyBox}
              </>
            ) : (
              <>
                {legacyBox}
                {printingApiBox}
              </>
            )}

            <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="none">
                {[
                  {
                    label: "精算ID",
                    value: result?.settlementId ? `…${result.settlementId.slice(-8)}` : "-",
                  },
                  { label: "対象日", value: formatYmdSlash(doneTargetDate) },
                  {
                    label: "総売上",
                    value:
                      doneTotal != null
                        ? `¥${Number(doneTotal).toLocaleString()}`
                        : "（再表示時は履歴から確認）",
                    valueBold: true,
                  },
                ].map((row, i, arr) => (
                  <SummaryRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    valueBold={row.valueBold}
                    divider={i < arr.length - 1}
                  />
                ))}
              </s-stack>
            </s-box>

            <s-button kind="primary" onClick={onBack}>
              閉じる
            </s-button>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 精算履歴画面 ──────────────────────────────────────────────────────────────
function HistoryDetailView({ item, onBack }) {
  return (
    <s-page heading="精算履歴明細">
      <s-stack
        gap="none"
        blockSize="100%"
        inlineSize="100%"
        minBlockSize="0"
        style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
      >
      <s-scroll-box blockSize="auto" maxBlockSize="100%" minBlockSize="0" style={{ flex: "1 1 0", minHeight: 0 }}>
        <s-box padding="base">
          {!item ? (
            <s-text tone="subdued">明細データがありません。</s-text>
          ) : (
            <s-stack gap="base">
              <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="none">
                  {[
                    { label: "対象日", value: formatYmdSlash(item.targetDate ?? "-") },
                    { label: "総売上", value: `¥${Number(item.total ?? 0).toLocaleString()}`, valueBold: true },
                    { label: "件数", value: `${Number(item.orderCount ?? 0)}件` },
                    { label: "点数", value: `${Number(item.itemCount ?? 0)}点` },
                    {
                      label: "種別",
                      value: item.periodLabel?.startsWith("点検_") ? "点検" : "精算",
                    },
                    { label: "ステータス", value: item.status ?? "-" },
                    {
                      label: "印字方式",
                      value:
                        item.printMode === "order_based"
                          ? `注文経由（${item.sourceOrderName ?? "-"}）`
                          : "CloudPRNT",
                    },
                  ].map((row, i, arr) => (
                    <SummaryRow
                      key={row.label}
                      label={row.label}
                      value={row.value}
                      valueBold={row.valueBold}
                      divider={i < arr.length - 1}
                    />
                  ))}
                </s-stack>
              </s-box>
            </s-stack>
          )}
        </s-box>
      </s-scroll-box>
      <s-divider />
      {/* 一覧に戻るボタンは、下の固定の左寄せに「戻る」でそろえる（T, 2026-11-23） */}
      <FixedFooterNavBar centerAlignWithButtons leftLabel="戻る" onLeft={onBack} />
      </s-stack>
    </s-page>
  );
}

// ── ヘルパー ──────────────────────────────────────────────────────────────────

/**
 * 精算プレビューの支払セクションが現金か（納金金額の対象）
 * 全角／半角の表記ゆれを少し吸収
 */
function isCashPaymentSection(section) {
  const g = String(section?.gateway ?? "").trim().toLowerCase();
  const l = String(section?.label ?? "").trim();
  const lNorm = typeof l.normalize === "function" ? l.normalize("NFKC") : l;
  if (g === "現金" || l === "現金" || lNorm === "現金") return true;
  if (g === "cash" || l.toLowerCase() === "cash") return true;
  return /^現金/.test(lNorm);
}

/** 明細1行：左に項目名、右寄せに値。下に区切り線（最下行は divider=false） */
function SummaryRow({
  label,
  value,
  bold, // 旧 props 互換（valueBold と同じ意味）
  valueBold = false,
  labelBold = false,
  divider = true,
}) {
  const vb = valueBold || bold;
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
            <s-text
              tone="subdued"
              size="small"
              fontWeight={labelBold ? "bold" : undefined}
            >
              {label}
            </s-text>
          </s-box>
          <s-box style={{ flex: "0 1 auto", minInlineSize: 0, textAlign: "end" }}>
            <s-text fontWeight={vb ? "bold" : undefined} size="small">
              {value}
            </s-text>
          </s-box>
        </s-stack>
      </s-box>
      {divider ? <s-divider /> : null}
    </s-stack>
  );
}
