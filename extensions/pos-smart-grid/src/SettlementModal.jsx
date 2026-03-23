/**
 * 精算モーダル
 * 要件書 §6, §23.1
 *
 * Steps:
 *   main     → 固定ヘッダー（ロケーション・年/月）+ 履歴一覧 + 固定フッター
 *   preview  → 精算プレビュー（集計結果表示）
 *   confirm  → 実行確認
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
  getSettlementHistory,
} from "../../common/settlementApi.js";
import { getAppUrl } from "../../common/appUrl.js";
import { getLocationsFromShopify } from "../../common/shopifyAdminGraphql.js";
import { useSessionLocation } from "../../common/sessionLocation.js";
import { toUserMessage } from "../../common/errorMessage.js";
import { getDailySummary } from "../../common/salesSummaryApi.js";

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

function parseYearMonthFromTargetDate(targetDate) {
  const s = String(targetDate || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

export default async () => {
  render(<SettlementModal />, document.body);
};

// ── Root ──────────────────────────────────────────────────────────────────────
function SettlementModal() {
  const [step, setStep] = useState("main");
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [targetDate, setTargetDate] = useState(todayStr());
  const [preview, setPreview] = useState(null);
  const [settlementResult, setSettlementResult] = useState(null);
  const [isInspection, setIsInspection] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [locationLoadError, setLocationLoadError] = useState("");
  const [allHistoryItems, setAllHistoryItems] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [selectedHistoryItem, setSelectedHistoryItem] = useState(null);
  const [monthDailyRows, setMonthDailyRows] = useState([]);
  const [monthDailyLoading, setMonthDailyLoading] = useState(false);
  const [monthDailyError, setMonthDailyError] = useState("");

  const initialYm = useMemo(() => todayYearMonth(), []);
  const [selectedYear, setSelectedYear] = useState(initialYm.year);
  const [selectedMonth, setSelectedMonth] = useState(initialYm.month);

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

  const loadAllHistory = useCallback(async (locationId) => {
    if (!locationId) {
      setAllHistoryItems([]);
      return;
    }
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const res = await getSettlementHistory({ locationId, limit: 300 });
      setAllHistoryItems(res?.items ?? []);
    } catch (e) {
      setHistoryError(toUserMessage(e?.message) || "履歴の取得に失敗しました");
      setAllHistoryItems([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // セッションのロケーションが確定したらロケーション一覧をロード
  useEffect(() => {
    if (sessionReady) {
      loadLocations(sessionLocationGid);
    }
  }, [sessionReady, sessionLocationGid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadAllHistory(selectedLocation?.locationId);
  }, [selectedLocation?.locationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const historyYearMonths = useMemo(() => {
    const map = new Map();
    for (const item of allHistoryItems) {
      const ym = parseYearMonthFromTargetDate(item?.targetDate);
      if (!ym) continue;
      const key = `${ym.year}-${String(ym.month).padStart(2, "0")}`;
      if (!map.has(key)) map.set(key, ym);
    }
    return Array.from(map.values()).sort((a, b) => (b.year - a.year) || (b.month - a.month));
  }, [allHistoryItems]);

  const availableYears = useMemo(() => {
    const set = new Set(historyYearMonths.map((x) => x.year));
    return Array.from(set).sort((a, b) => b - a);
  }, [historyYearMonths]);

  const availableMonthsForYear = useMemo(() => {
    const set = new Set(
      historyYearMonths.filter((x) => x.year === selectedYear).map((x) => x.month)
    );
    return Array.from(set).sort((a, b) => b - a);
  }, [historyYearMonths, selectedYear]);

  useEffect(() => {
    if (availableYears.length === 0) return;
    if (!availableYears.includes(selectedYear)) {
      const y = availableYears[0];
      setSelectedYear(y);
      const months = historyYearMonths.filter((x) => x.year === y).map((x) => x.month).sort((a, b) => b - a);
      if (months.length > 0) setSelectedMonth(months[0]);
      return;
    }
    if (availableMonthsForYear.length > 0 && !availableMonthsForYear.includes(selectedMonth)) {
      setSelectedMonth(availableMonthsForYear[0]);
    }
  }, [availableYears, availableMonthsForYear, selectedYear, selectedMonth, historyYearMonths]);

  const monthlyHistoryItems = useMemo(() => {
    return allHistoryItems
      .filter((item) => {
        const ym = parseYearMonthFromTargetDate(item?.targetDate);
        return ym && ym.year === selectedYear && ym.month === selectedMonth;
      })
      .sort((a, b) => {
        const ta = new Date(a?.createdAt ?? a?.updatedAt ?? a?.targetDate ?? 0).getTime();
        const tb = new Date(b?.createdAt ?? b?.updatedAt ?? b?.targetDate ?? 0).getTime();
        return tb - ta;
      });
  }, [allHistoryItems, selectedYear, selectedMonth]);

  const loadMonthDailyRows = useCallback(async (locationId, year, month) => {
    if (!locationId || !year || !month) {
      setMonthDailyRows([]);
      return;
    }
    setMonthDailyLoading(true);
    setMonthDailyError("");
    try {
      const daysInMonth = new Date(year, month, 0).getDate();
      const requests = [];
      for (let day = 1; day <= daysInMonth; day++) {
        const targetDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        requests.push(
          getDailySummary({ targetDate, locationIds: [locationId] }).then((res) => ({
            targetDate,
            row: Array.isArray(res?.rows) ? (res.rows[0] ?? null) : null,
          }))
        );
      }
      const list = await Promise.all(requests);
      const latestSettlementByDate = new Map();
      for (const item of monthlyHistoryItems) {
        const key = String(item?.targetDate || "");
        if (!key) continue;
        const prev = latestSettlementByDate.get(key);
        if (!prev) {
          latestSettlementByDate.set(key, item);
          continue;
        }
        const prevTime = new Date(prev?.createdAt ?? prev?.updatedAt ?? 0).getTime();
        const curTime = new Date(item?.createdAt ?? item?.updatedAt ?? 0).getTime();
        if (curTime > prevTime) latestSettlementByDate.set(key, item);
      }
      const rows = list
        .map(({ targetDate, row }) => ({
          targetDate,
          actual: Number(row?.actual ?? 0),
          orders: Number(row?.orders ?? 0),
          items: Number(row?.items ?? 0),
          settlement: latestSettlementByDate.get(targetDate) ?? null,
        }))
        .sort((a, b) => (a.targetDate < b.targetDate ? 1 : -1));
      setMonthDailyRows(rows);
    } catch (e) {
      setMonthDailyRows([]);
      setMonthDailyError(toUserMessage(e?.message) || "日別集計の取得に失敗しました");
    } finally {
      setMonthDailyLoading(false);
    }
  }, [monthlyHistoryItems]);

  const handlePreview = useCallback(
    async (inspection = false) => {
      if (!selectedLocation) return;
      setLoading(true);
      setError("");
      setIsInspection(inspection);
      try {
        const res = await previewSettlement({
          locationId: selectedLocation.locationId,
          locationName: selectedLocation.locationName,
          targetDate,
        });
        setPreview(res.preview);
        setStep("preview");
      } catch (e) {
        setError(toUserMessage(e?.message) || "プレビューの取得に失敗しました");
      } finally {
        setLoading(false);
      }
    },
    [selectedLocation, targetDate]
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
        printMode: selectedLocation.printMode,
        isInspection,
      });
      setSettlementResult(res);
      setStep("done");
    } catch (e) {
      setError(toUserMessage(e?.message) || "精算の実行に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation, preview, targetDate, isInspection]);

  const handleDirectSettle = useCallback(async () => {
    if (!selectedLocation) return;
    setLoading(true);
    setError("");
    setIsInspection(false);
    try {
      const res = await previewSettlement({
        locationId: selectedLocation.locationId,
        locationName: selectedLocation.locationName,
        targetDate,
      });
      setPreview(res.preview);
      setStep("confirm");
    } catch (e) {
      setError(toUserMessage(e?.message) || "精算準備に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation, targetDate]);

  const handleOpenDailyRow = useCallback(async (row) => {
    const d = String(row?.targetDate || "").trim();
    if (!d || !selectedLocation) return;
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
      setPreview(res.preview);
    } catch (e) {
      setError(toUserMessage(e?.message) || "再集計に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation, targetDate]);

  useEffect(() => {
    loadMonthDailyRows(selectedLocation?.locationId, selectedYear, selectedMonth);
  }, [selectedLocation?.locationId, selectedYear, selectedMonth, loadMonthDailyRows]);

  if (step === "main") {
    return (
      <MainView
        locations={locations}
        selectedLocation={selectedLocation}
        selectedYear={selectedYear}
        selectedMonth={selectedMonth}
        availableYears={availableYears}
        availableMonthsForYear={availableMonthsForYear}
        dailyRows={monthDailyRows}
        dailyLoading={monthDailyLoading || historyLoading}
        dailyError={monthDailyError || historyError}
        loading={loading}
        error={error}
        locationLoadError={locationLoadError}
        onSelectLocation={(loc) => setSelectedLocation(loc)}
        onSelectYear={(year) => {
          setSelectedYear(year);
          const months = historyYearMonths
            .filter((x) => x.year === year)
            .map((x) => x.month)
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
        onPreview={() => handlePreview(false)}
        onInspection={() => handlePreview(true)}
        onSettle={handleDirectSettle}
        onOpenDailyRow={handleOpenDailyRow}
        onRetryLocations={loadLocations}
        onRetryDaily={() => {
          loadAllHistory(selectedLocation?.locationId);
          loadMonthDailyRows(selectedLocation?.locationId, selectedYear, selectedMonth);
        }}
        setError={setError}
      />
    );
  }

  if (step === "preview") {
    return (
      <PreviewView
        preview={preview}
        isInspection={isInspection}
        printMode={selectedLocation?.printMode}
        loading={loading}
        error={error}
        onRecalculate={handleRecalculate}
        onConfirm={() => setStep("confirm")}
        onBack={() => setStep("main")}
      />
    );
  }

  if (step === "confirm") {
    return (
      <ConfirmView
        preview={preview}
        isInspection={isInspection}
        printMode={selectedLocation?.printMode}
        loading={loading}
        error={error}
        onExecute={handleCreate}
        onBack={() => setStep("preview")}
      />
    );
  }

  if (step === "done") {
    return (
      <DoneView
        result={settlementResult}
        isInspection={isInspection}
        onBack={() => { setStep("main"); setPreview(null); setSettlementResult(null); }}
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
  onPreview,
  onInspection,
  onSettle,
  onOpenDailyRow,
  onRetryLocations,
  onRetryDaily,
  setError,
}) {
  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);

  const handleLocChange = (e) => {
    const id = e?.currentTarget?.value ?? e?.currentValue?.value;
    const loc = locations.find((l) => l.locationId === id);
    if (loc) onSelectLocation(loc);
  };

  return (
    <s-page heading="精算">
      <s-stack gap="none" blockSize="100%" inlineSize="100%" minBlockSize="0">
        <s-box padding="base">
          <s-stack gap="base">
            {locationLoadError ? (
              <s-stack gap="small">
                <s-text tone="critical">{locationLoadError}</s-text>
                <s-button kind="secondary" onClick={onRetryLocations} loading={loading}>
                  再読み込み
                </s-button>
              </s-stack>
            ) : locations.length > 1 ? (
              <s-select
                label="ロケーション"
                value={selectedLocation?.locationId ?? ""}
                onChange={handleLocChange}
              >
                {locations.map((loc) => (
                  <s-option key={loc.locationId} value={loc.locationId}>
                    {loc.locationName}
                  </s-option>
                ))}
              </s-select>
            ) : selectedLocation ? (
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="extraSmall">
                  <s-text tone="subdued" fontSize="small">ロケーション</s-text>
                  <s-text fontWeight="bold">{selectedLocation.locationName}</s-text>
                </s-stack>
              </s-box>
            ) : loading ? (
              <s-text tone="subdued">ロケーションを読み込み中…</s-text>
            ) : (
              <s-stack gap="small">
                <s-text tone="subdued">ロケーションが見つかりません</s-text>
                <s-button kind="plain" onClick={onRetryLocations}>再読み込み</s-button>
              </s-stack>
            )}
          </s-stack>
        </s-box>

        <s-box padding="base" paddingBlockStart="none">
          <s-stack direction="horizontal" align="space-between" blockAlignment="center" gap="small">
            <s-text fontWeight="bold">{selectedLocation?.locationName ?? "ロケーション未選択"}</s-text>
            <s-stack direction="horizontal" gap="small">
              <s-stack gap="extraSmall">
                <s-button
                  kind="secondary"
                  onClick={() => {
                    setMonthMenuOpen(false);
                    setYearMenuOpen((v) => !v);
                  }}
                >
                  {selectedYear}年
                </s-button>
              {yearMenuOpen ? (
                <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack gap="extraSmall">
                    {availableYears.length === 0 ? (
                      <s-text tone="subdued" fontSize="small">履歴のある年がありません</s-text>
                    ) : (
                      availableYears.map((y) => (
                        <s-button
                          key={`year-${y}`}
                          kind={y === selectedYear ? "primary" : "secondary"}
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
              </s-stack>
              <s-stack gap="extraSmall">
                <s-button
                  kind="secondary"
                  onClick={() => {
                    setYearMenuOpen(false);
                    setMonthMenuOpen((v) => !v);
                  }}
                >
                  {selectedMonth}月
                </s-button>
              {monthMenuOpen ? (
                <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack gap="extraSmall">
                    {availableMonthsForYear.length === 0 ? (
                      <s-text tone="subdued" fontSize="small">履歴のある月がありません</s-text>
                    ) : (
                      availableMonthsForYear.map((m) => (
                        <s-button
                          key={`month-${m}`}
                          kind={m === selectedMonth ? "primary" : "secondary"}
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
            </s-stack>
          </s-stack>
        </s-box>
        <s-divider />
        <s-scroll-box blockSize="auto" maxBlockSize="100%" minBlockSize="0">
          <s-box padding="base">
            {dailyLoading ? (
              <s-text tone="subdued">読み込み中…</s-text>
            ) : dailyError ? (
              <s-stack gap="small">
                <s-text tone="critical">{dailyError}</s-text>
                <s-button kind="secondary" onClick={onRetryDaily}>再読み込み</s-button>
              </s-stack>
            ) : (
              <s-stack gap="small">
                {dailyRows.map((row) => (
                  <s-box key={row.targetDate}>
                    <s-clickable onClick={() => onOpenDailyRow(row)}>
                      <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                        <s-stack gap="extraSmall">
                          <s-stack direction="horizontal" align="space-between">
                            <s-text fontWeight="bold">{row.targetDate}</s-text>
                            <s-text fontWeight="bold">¥{Number(row.actual).toLocaleString()}</s-text>
                          </s-stack>
                          <s-stack direction="horizontal" align="space-between">
                            <s-text tone="subdued" fontSize="small">
                              {row.orders}件 / {row.items}点
                            </s-text>
                            <s-text tone="subdued" fontSize="small">
                              {row.settlement
                                ? (row.settlement.periodLabel?.startsWith("点検_") ? "点検済み" : "精算済み")
                                : "未精算"}
                            </s-text>
                          </s-stack>
                          <s-text tone="subdued" fontSize="small">
                            {row.settlement
                              ? (row.settlement.printMode === "order_based"
                                ? `注文: ${row.settlement.sourceOrderName ?? "-"}`
                                : "CloudPRNT")
                              : "タップで日別明細"}
                          </s-text>
                        </s-stack>
                      </s-box>
                    </s-clickable>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-box>
        </s-scroll-box>
        <s-divider />
        <s-box padding="base">
          {error ? (
            <s-box paddingBlockEnd="small">
              <s-text tone="critical">{error}</s-text>
            </s-box>
          ) : null}
          <s-stack direction="horizontal" gap="small">
            <s-box style={{ flex: 1 }}>
              <s-button kind="secondary" onClick={onPreview} loading={loading} disabled={!selectedLocation}>
                精算プレビュー
              </s-button>
            </s-box>
            <s-box style={{ flex: 1 }}>
              <s-button kind="secondary" onClick={onInspection} loading={loading} disabled={!selectedLocation}>
                点検
              </s-button>
            </s-box>
            <s-box style={{ flex: 1 }}>
              <s-button kind="primary" onClick={onSettle} loading={loading} disabled={!selectedLocation}>
                精算
              </s-button>
            </s-box>
          </s-stack>
        </s-box>
      </s-stack>
    </s-page>
  );
}

// ── プレビュー画面 ─────────────────────────────────────────────────────────────
function PreviewView({
  preview,
  isInspection,
  printMode,
  loading,
  error,
  onRecalculate,
  onConfirm,
  onBack,
}) {
  if (!preview) return null;
  const printModeLabel = printMode === "cloudprnt_direct" ? "CloudPRNT直印字" : "注文経由印字";

  return (
    <s-page heading={isInspection ? "点検レシート プレビュー" : "精算プレビュー"}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">

            {/* ヘッダー */}
            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="extraSmall">
                <s-text fontWeight="bold">{preview.locationName}</s-text>
                <s-text tone="subdued" fontSize="small">対象日: {preview.targetDate}</s-text>
                <s-text tone="subdued" fontSize="small">印字方式: {printModeLabel}</s-text>
              </s-stack>
            </s-box>

            {/* 集計サマリー */}
            <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="small">
                <SummaryRow label="総売上" value={`¥${Number(preview.total).toLocaleString()}`} bold />
                <SummaryRow label="純売上" value={`¥${Number(preview.netSales).toLocaleString()}`} />
                <SummaryRow label="消費税" value={`¥${Number(preview.tax).toLocaleString()}`} />
                <SummaryRow label="割引" value={`▲¥${Number(preview.discounts).toLocaleString()}`} />
                <SummaryRow label="返金" value={`▲¥${Number(preview.refundTotal).toLocaleString()}`} />
                {Number(preview.voucherChangeAmount) > 0 ? (
                  <SummaryRow
                    label="商品券釣有り差額"
                    value={`¥${Number(preview.voucherChangeAmount).toLocaleString()}`}
                  />
                ) : null}
              </s-stack>
            </s-box>

            {/* 件数・点数 */}
            <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="small">
                <SummaryRow label="売上件数" value={`${preview.orderCount}件`} />
                <SummaryRow label="返金件数" value={`${preview.refundCount}件`} />
                <SummaryRow label="点数" value={`${preview.itemCount}点`} />
              </s-stack>
            </s-box>

            {/* 支払方法別内訳（売上額・返金額・件数） */}
            {preview.paymentSections?.length > 0 ? (
              <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-text fontWeight="bold" fontSize="small">支払方法別内訳</s-text>
                <s-stack gap="extraSmall" paddingBlockStart="small">
                  {preview.paymentSections.map((section) => (
                    <s-box key={section.gateway} paddingBlock="extraSmall">
                      <s-stack gap="extraSmall">
                        <s-stack direction="horizontal" align="space-between">
                          <s-text fontWeight="bold" fontSize="small">{section.label}</s-text>
                          <s-text fontSize="small">¥{Number(section.net).toLocaleString()}</s-text>
                        </s-stack>
                        <s-stack direction="horizontal" align="space-between">
                          <s-text tone="subdued" fontSize="small">　件数</s-text>
                          <s-text tone="subdued" fontSize="small">
                            {Number(section.txCount ?? 0)}件
                            {Number(section.refundCount ?? 0) > 0 ? `（返金${section.refundCount}件）` : ""}
                          </s-text>
                        </s-stack>
                        {Number(section.refund) > 0 ? (
                          <s-stack direction="horizontal" align="space-between">
                            <s-text tone="subdued" fontSize="small">　返金</s-text>
                            <s-text tone="subdued" fontSize="small">▲¥{Number(section.refund).toLocaleString()}</s-text>
                          </s-stack>
                        ) : null}
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              </s-box>
            ) : null}

            {/* 適用済み特殊返金・商品券調整 */}
            {(preview.appliedSpecialRefundEvents?.length > 0 || preview.appliedVoucherAdjustments?.length > 0) ? (
              <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-text fontWeight="bold" fontSize="small">適用済みイベント</s-text>
                <s-stack gap="extraSmall" paddingBlockStart="small">
                  {preview.appliedSpecialRefundEvents?.map((ev) => (
                    <s-text key={ev.id} tone="subdued" fontSize="small">
                      {ev.sourceOrderName} — {ev.eventType} ¥{Number(ev.amount).toLocaleString()}
                    </s-text>
                  ))}
                  {preview.appliedVoucherAdjustments?.map((ev) => (
                    <s-text key={ev.id} tone="subdued" fontSize="small">
                      {ev.sourceOrderName} — 商品券釣有り ¥{Number(ev.voucherChangeAmount).toLocaleString()}
                    </s-text>
                  ))}
                </s-stack>
              </s-box>
            ) : null}

            {error ? <s-text tone="critical">{error}</s-text> : null}

            {/* アクションボタン */}
            <s-stack gap="small">
              <s-button kind="primary" onClick={onConfirm} disabled={loading}>
                {isInspection ? "点検レシートを発行する" : "精算レシートを発行する"}
              </s-button>
              <s-button kind="secondary" onClick={onRecalculate} loading={loading}>
                再集計
              </s-button>
              <s-button kind="plain" onClick={onBack} disabled={loading}>
                ← 戻る
              </s-button>
            </s-stack>

          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 確認画面 ──────────────────────────────────────────────────────────────────
function ConfirmView({ preview, isInspection, printMode, loading, error, onExecute, onBack }) {
  const printModeLabel = printMode === "cloudprnt_direct"
    ? "CloudPRNT直印字"
    : "注文経由印字（精算注文を作成します）";

  return (
    <s-page heading="発行確認">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text fontWeight="bold">
              {isInspection ? "点検レシートを発行します" : "精算レシートを発行します"}
            </s-text>

            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="small">
                <SummaryRow label="ロケーション" value={preview?.locationName ?? "-"} />
                <SummaryRow label="対象日" value={preview?.targetDate ?? "-"} />
                <SummaryRow label="総売上" value={`¥${Number(preview?.total ?? 0).toLocaleString()}`} bold />
                <SummaryRow label="件数" value={`${preview?.orderCount ?? 0}件`} />
                <SummaryRow label="印字方式" value={printModeLabel} />
              </s-stack>
            </s-box>

            {error ? <s-text tone="critical">{error}</s-text> : null}

            <s-stack gap="small">
              <s-button kind="primary" onClick={onExecute} loading={loading}>
                発行する
              </s-button>
              <s-button kind="secondary" onClick={onBack} disabled={loading}>
                戻る
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 完了画面 ──────────────────────────────────────────────────────────────────
function DoneView({ result, isInspection, onBack }) {
  const isOrderBased = result?.printMode === "order_based";

  return (
    <s-page heading="発行完了">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text fontWeight="bold">
              {isInspection ? "点検レシートを保存しました" : "精算レシートを保存しました"}
            </s-text>

            {isOrderBased && result?.sourceOrderName ? (
              <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <s-text fontWeight="bold">注文経由印字</s-text>
                  <s-text tone="subdued">
                    精算注文 <s-text fontWeight="bold">{result.sourceOrderName}</s-text> を作成しました。
                  </s-text>
                  <s-text tone="subdued" fontSize="small">
                    POS の注文一覧からこの注文を開き、レシートを印刷してください。
                  </s-text>
                </s-stack>
              </s-box>
            ) : (
              <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <s-text fontWeight="bold">CloudPRNT 直印字</s-text>
                  <s-text tone="subdued">精算データを保存しました。プリンタから印刷されます。</s-text>
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
            )}

            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="small">
                <SummaryRow
                  label="精算ID"
                  value={result?.settlementId ? `…${result.settlementId.slice(-8)}` : "-"}
                />
                <SummaryRow label="対象日" value={result?.preview?.targetDate ?? "-"} />
                <SummaryRow
                  label="総売上"
                  value={`¥${Number(result?.preview?.total ?? 0).toLocaleString()}`}
                  bold
                />
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
      <s-scroll-box>
        <s-box padding="base">
          {!item ? (
            <s-text tone="subdued">明細データがありません。</s-text>
          ) : (
            <s-stack gap="small">
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <SummaryRow label="対象日" value={item.targetDate ?? "-"} />
                  <SummaryRow label="総売上" value={`¥${Number(item.total ?? 0).toLocaleString()}`} bold />
                  <SummaryRow label="件数" value={`${Number(item.orderCount ?? 0)}件`} />
                  <SummaryRow label="点数" value={`${Number(item.itemCount ?? 0)}点`} />
                  <SummaryRow
                    label="種別"
                    value={item.periodLabel?.startsWith("点検_") ? "点検" : "精算"}
                  />
                  <SummaryRow label="ステータス" value={item.status ?? "-"} />
                  <SummaryRow
                    label="印字方式"
                    value={
                      item.printMode === "order_based"
                        ? `注文経由（${item.sourceOrderName ?? "-"}）`
                        : "CloudPRNT"
                    }
                  />
                </s-stack>
              </s-box>
            </s-stack>
          )}
        </s-box>
        <s-box padding="base">
          <s-button kind="plain" onClick={onBack}>← 戻る</s-button>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── ヘルパー ──────────────────────────────────────────────────────────────────
function SummaryRow({ label, value, bold = false }) {
  return (
    <s-stack direction="horizontal" align="space-between">
      <s-text tone="subdued" fontSize="small">{label}</s-text>
      <s-text fontWeight={bold ? "bold" : undefined}>{value}</s-text>
    </s-stack>
  );
}
