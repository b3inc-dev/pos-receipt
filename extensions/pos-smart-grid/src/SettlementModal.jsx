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
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";

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

/** 年月を数値で比較（a < b なら負） */
function compareYearMonth(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

/**
 * 精算履歴に出てきた年月 ＋ その範囲から今日までの「カレンダー上ある」年月をすべて含める。
 * 履歴ゼロのときは「今年の1月〜今月」まで選べる。
 */
function buildSelectableYearMonths(historyItems) {
  const map = new Map();
  for (const item of historyItems) {
    const ym = parseYearMonthFromTargetDate(item?.targetDate);
    if (!ym) continue;
    const key = `${ym.year}-${String(ym.month).padStart(2, "0")}`;
    if (!map.has(key)) map.set(key, ym);
  }

  const d = new Date();
  const cur = { year: d.getFullYear(), month: d.getMonth() + 1 };

  let rangeStart;
  if (map.size === 0) {
    rangeStart = { year: cur.year, month: 1 };
  } else {
    rangeStart = { year: cur.year, month: cur.month };
    for (const ym of map.values()) {
      if (compareYearMonth(ym, rangeStart) < 0) rangeStart = { year: ym.year, month: ym.month };
    }
  }

  if (compareYearMonth(rangeStart, cur) > 0) {
    rangeStart = { year: cur.year, month: cur.month };
  }

  let y = rangeStart.year;
  let m = rangeStart.month;
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (!map.has(key)) map.set(key, { year: y, month: m });
    if (y === cur.year && m === cur.month) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  return Array.from(map.values()).sort((a, b) => (b.year - a.year) || (b.month - a.month));
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

  const selectableYearMonths = useMemo(
    () => buildSelectableYearMonths(allHistoryItems),
    [allHistoryItems]
  );

  const availableYears = useMemo(() => {
    const set = new Set(selectableYearMonths.map((x) => x.year));
    return Array.from(set).sort((a, b) => b - a);
  }, [selectableYearMonths]);

  const availableMonthsForYear = useMemo(() => {
    const set = new Set(
      selectableYearMonths.filter((x) => x.year === selectedYear).map((x) => x.month)
    );
    return Array.from(set).sort((a, b) => b - a);
  }, [selectableYearMonths, selectedYear]);

  useEffect(() => {
    if (availableYears.length === 0) return;
    if (!availableYears.includes(selectedYear)) {
      const y = availableYears[0];
      setSelectedYear(y);
      const months = selectableYearMonths.filter((x) => x.year === y).map((x) => x.month).sort((a, b) => b - a);
      if (months.length > 0) setSelectedMonth(months[0]);
      return;
    }
    if (availableMonthsForYear.length > 0 && !availableMonthsForYear.includes(selectedMonth)) {
      setSelectedMonth(availableMonthsForYear[0]);
    }
  }, [availableYears, availableMonthsForYear, selectedYear, selectedMonth, selectableYearMonths]);

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
      const today = todayStr();
      const list = [];
      for (let day = 1; day <= daysInMonth; day++) {
        const targetDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        // 「まだ来ていない日」（今日より未来）は一覧に出さない・API も呼ばない
        if (targetDate > today) break;
        // Throttled(HTTP 500) 回避のため、日次APIは逐次呼び出しにする
        // （同時31本のリクエストを避ける）
        // eslint-disable-next-line no-await-in-loop
        const res = await getDailySummary({ targetDate, locationIds: [locationId] });
        list.push({
          targetDate,
          row: Array.isArray(res?.rows) ? (res.rows[0] ?? null) : null,
        });
      }
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
          // 日次APIの actual はサーバー上で純売上（netSales）として計算されている
          netSales: Number(row?.actual ?? 0),
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
          const months = selectableYearMonths
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
      <s-stack
        gap="none"
        blockSize="100%"
        inlineSize="100%"
        minBlockSize="0"
        style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
      >
        {/* POS Stock の setHeader 相当：sticky + 枠線（入庫モーダルヘッダーと同系統） */}
        <s-box
          padding="base"
          border="base"
          style={{ position: "sticky", top: 0, background: "var(--s-color-bg)", zIndex: 10 }}
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
                      <s-select
                        label=""
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
                      <s-text emphasis="bold" size="small">{selectedLocation.locationName}</s-text>
                    ) : loading ? (
                      <s-text tone="subdued" size="small">ロケーションを読み込み中…</s-text>
                    ) : (
                      <s-stack gap="small">
                        <s-text tone="subdued" size="small">ロケーションが見つかりません</s-text>
                        <s-button kind="plain" onClick={onRetryLocations}>再読み込み</s-button>
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
                {/* 上の行の直下：年または月の選択リスト（同行には出さない） */}
                {yearMenuOpen ? (
                  <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                    <s-stack gap="extraSmall">
                      {availableYears.length === 0 ? (
                        <s-text tone="subdued" fontSize="small">選べる年がありません</s-text>
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
                {monthMenuOpen ? (
                  <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                    <s-stack gap="extraSmall">
                      {availableMonthsForYear.length === 0 ? (
                        <s-text tone="subdued" fontSize="small">選べる月がありません</s-text>
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
            )}
          </s-stack>
        </s-box>

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
                    <s-clickable key={row.targetDate} onClick={() => onOpenDailyRow(row)}>
                      <s-box padding="small">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                          <s-text
                            emphasis="bold"
                            size="small"
                            style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                          >
                            {row.targetDate}
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

        <FixedFooterNavBar
          centerAlignWithButtons
          leftLabel="精算プレビュー"
          onLeft={onPreview}
          leftDisabled={!selectedLocation}
          leftLoading={loading}
          middleLabel="点検"
          onMiddle={onInspection}
          middleDisabled={!selectedLocation}
          middleLoading={loading}
          rightLabel="精算"
          onRight={onSettle}
          rightTone="success"
          rightDisabled={!selectedLocation}
          rightLoading={loading}
        />
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

  const headerRows = [
    { label: "ロケーション", value: preview.locationName ?? "-", valueBold: true },
    { label: "対象日", value: preview.targetDate ?? "-" },
    { label: "印字方式", value: printModeLabel },
  ];

  const summaryRows = [
    { label: "総売上", value: `¥${Number(preview.total).toLocaleString()}`, valueBold: true },
    { label: "純売上", value: `¥${Number(preview.netSales).toLocaleString()}` },
    { label: "消費税", value: `¥${Number(preview.tax).toLocaleString()}` },
    { label: "割引", value: `▲¥${Number(preview.discounts).toLocaleString()}` },
    { label: "返金", value: `▲¥${Number(preview.refundTotal).toLocaleString()}` },
  ];
  if (Number(preview.voucherChangeAmount) > 0) {
    summaryRows.push({
      label: "商品券釣有り差額",
      value: `¥${Number(preview.voucherChangeAmount).toLocaleString()}`,
    });
  }

  const countRows = [
    { label: "売上件数", value: `${preview.orderCount}件` },
    { label: "返金件数", value: `${preview.refundCount}件` },
    { label: "点数", value: `${preview.itemCount}点` },
  ];

  const paymentDetailRows = [];
  if (preview.paymentSections?.length > 0) {
    for (const section of preview.paymentSections) {
      paymentDetailRows.push({
        key: `${section.gateway}-net`,
        label: section.label,
        value: `¥${Number(section.net).toLocaleString()}`,
        labelBold: true,
      });
      paymentDetailRows.push({
        key: `${section.gateway}-tx`,
        label: "件数",
        value: `${Number(section.txCount ?? 0)}件${
          Number(section.refundCount ?? 0) > 0 ? `（返金${section.refundCount}件）` : ""
        }`,
      });
      if (Number(section.refund) > 0) {
        paymentDetailRows.push({
          key: `${section.gateway}-refund`,
          label: "返金",
          value: `▲¥${Number(section.refund).toLocaleString()}`,
        });
      }
    }
  }

  const eventRows = [];
  for (const ev of preview.appliedSpecialRefundEvents ?? []) {
    eventRows.push({
      key: `sr-${ev.id}`,
      label: `${ev.sourceOrderName ?? "-"}（${ev.eventType ?? "-"}）`,
      value: `¥${Number(ev.amount).toLocaleString()}`,
    });
  }
  for (const ev of preview.appliedVoucherAdjustments ?? []) {
    eventRows.push({
      key: `va-${ev.id}`,
      label: `${ev.sourceOrderName ?? "-"}（商品券釣有り）`,
      value: `¥${Number(ev.voucherChangeAmount).toLocaleString()}`,
    });
  }

  return (
    <s-page heading={isInspection ? "点検レシート プレビュー" : "精算プレビュー"}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">

            {/* ヘッダー（枠内は行ごと small パディング＋区切り＝リストと同系統） */}
            <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="none">
                {headerRows.map((row, i) => (
                  <SummaryRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    valueBold={row.valueBold}
                    divider={i < headerRows.length - 1}
                  />
                ))}
              </s-stack>
            </s-box>

            {/* 集計サマリー */}
            <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="none">
                {summaryRows.map((row, i) => (
                  <SummaryRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    valueBold={row.valueBold}
                    divider={i < summaryRows.length - 1}
                  />
                ))}
              </s-stack>
            </s-box>

            {/* 件数・点数 */}
            <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="none">
                {countRows.map((row, i) => (
                  <SummaryRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    divider={i < countRows.length - 1}
                  />
                ))}
              </s-stack>
            </s-box>

            {/* 支払方法別内訳（売上額・返金額・件数） */}
            {paymentDetailRows.length > 0 ? (
              <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="none">
                  <s-box padding="small">
                    <s-text fontWeight="bold" fontSize="small">支払方法別内訳</s-text>
                  </s-box>
                  <s-divider />
                  {paymentDetailRows.map((row, i) => (
                    <SummaryRow
                      key={row.key}
                      label={row.label}
                      value={row.value}
                      labelBold={row.labelBold}
                      divider={i < paymentDetailRows.length - 1}
                    />
                  ))}
                </s-stack>
              </s-box>
            ) : null}

            {/* 適用済み特殊返金・商品券調整 */}
            {eventRows.length > 0 ? (
              <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="none">
                  <s-box padding="small">
                    <s-text fontWeight="bold" fontSize="small">適用済みイベント</s-text>
                  </s-box>
                  <s-divider />
                  {eventRows.map((row, i) => (
                    <SummaryRow
                      key={row.key}
                      label={row.label}
                      value={row.value}
                      divider={i < eventRows.length - 1}
                    />
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

            <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="none">
                {[
                  { label: "ロケーション", value: preview?.locationName ?? "-" },
                  { label: "対象日", value: preview?.targetDate ?? "-" },
                  { label: "総売上", value: `¥${Number(preview?.total ?? 0).toLocaleString()}`, valueBold: true },
                  { label: "件数", value: `${preview?.orderCount ?? 0}件` },
                  { label: "印字方式", value: printModeLabel },
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

            <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="none">
                {[
                  {
                    label: "精算ID",
                    value: result?.settlementId ? `…${result.settlementId.slice(-8)}` : "-",
                  },
                  { label: "対象日", value: result?.preview?.targetDate ?? "-" },
                  {
                    label: "総売上",
                    value: `¥${Number(result?.preview?.total ?? 0).toLocaleString()}`,
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
      <s-scroll-box>
        <s-box padding="base">
          {!item ? (
            <s-text tone="subdued">明細データがありません。</s-text>
          ) : (
            <s-stack gap="base">
              <s-box padding="none" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="none">
                  {[
                    { label: "対象日", value: item.targetDate ?? "-" },
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
        <s-box padding="base">
          <s-button kind="plain" onClick={onBack}>← 戻る</s-button>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── ヘルパー ──────────────────────────────────────────────────────────────────
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
