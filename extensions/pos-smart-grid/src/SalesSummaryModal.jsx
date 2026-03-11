/**
 * 売上サマリーモーダル
 * 要件書 §23.4
 *
 * Flow: 日付指定（daily）/ 期間指定（period）モード選択
 *   → ロケーション別KPIカード表示
 *   → 入店数入力（footfallReportingEnabled の店舗のみ）
 */
import { useState, useEffect, useCallback } from "preact/hooks";
import { render } from "preact";
import {
  getDailySummary,
  getPeriodSummary,
  reportFootfall,
} from "../../common/salesSummaryApi.js";

export default async () => {
  render(<SalesSummaryModal />, document.body);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}
function firstOfMonth() {
  return today().slice(0, 8) + "01";
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

// ── Root Component ────────────────────────────────────────────────────────────

function SalesSummaryModal() {
  const [mode, setMode] = useState("daily"); // "daily" | "period"
  const [targetDate, setTargetDate] = useState(today());
  const [dateFrom, setDateFrom] = useState(firstOfMonth());
  const [dateTo, setDateTo] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [footfallInputs, setFootfallInputs] = useState({});
  const [savingFootfall, setSavingFootfall] = useState({});
  const [footfallError, setFootfallError] = useState({});

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let result;
      if (mode === "daily") {
        result = await getDailySummary({ targetDate });
      } else {
        result = await getPeriodSummary({ dateFrom, dateTo });
      }
      setData(result);
      // 入店数の初期値をロード
      if (result.rows) {
        const inputs = {};
        for (const row of result.rows) {
          if (row.visitors !== null && row.visitors !== undefined) {
            inputs[row.locationId] = String(row.visitors);
          }
        }
        setFootfallInputs((prev) => ({ ...inputs, ...prev }));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [mode, targetDate, dateFrom, dateTo]);

  // 初回ロード
  useEffect(() => {
    loadData();
  }, []);

  const handleSaveFootfall = async (locationId) => {
    const visitors = parseInt(footfallInputs[locationId] ?? "0", 10);
    if (isNaN(visitors)) return;
    setSavingFootfall((s) => ({ ...s, [locationId]: true }));
    setFootfallError((s) => ({ ...s, [locationId]: null }));
    try {
      await reportFootfall({ locationId, targetDate, visitors });
      await loadData();
    } catch (err) {
      setFootfallError((s) => ({ ...s, [locationId]: err.message }));
    } finally {
      setSavingFootfall((s) => ({ ...s, [locationId]: false }));
    }
  };

  const rows = data?.rows ?? [];
  const totals = data?.totals ?? {};

  return (
    <s-page heading="売上サマリー">
      {/* ── モード選択 ── */}
      <s-box padding="base">
        <s-inline spacing="tight">
          <s-button
            variant={mode === "daily" ? "primary" : "secondary"}
            onPress={() => setMode("daily")}
          >
            日付指定
          </s-button>
          <s-button
            variant={mode === "period" ? "primary" : "secondary"}
            onPress={() => setMode("period")}
          >
            期間指定
          </s-button>
        </s-inline>
      </s-box>

      {/* ── 日付入力 ── */}
      <s-box padding="base" paddingBlockStart="none">
        {mode === "daily" ? (
          <s-text-field
            label="対象日（YYYY-MM-DD）"
            value={targetDate}
            onChange={(e) =>
              setTargetDate(e.detail?.value ?? e.target?.value ?? targetDate)
            }
          />
        ) : (
          <s-stack spacing="base">
            <s-text-field
              label="開始日（YYYY-MM-DD）"
              value={dateFrom}
              onChange={(e) =>
                setDateFrom(e.detail?.value ?? e.target?.value ?? dateFrom)
              }
            />
            <s-text-field
              label="終了日（YYYY-MM-DD）"
              value={dateTo}
              onChange={(e) =>
                setDateTo(e.detail?.value ?? e.target?.value ?? dateTo)
              }
            />
          </s-stack>
        )}
        <s-box paddingBlockStart="base">
          <s-button variant="primary" onPress={loadData} disabled={loading}>
            {loading ? "読み込み中..." : "表示"}
          </s-button>
        </s-box>
      </s-box>

      {/* ── エラー ── */}
      {error && (
        <s-box padding="base">
          <s-banner status="critical">{error}</s-banner>
        </s-box>
      )}

      {/* ── データ表示 ── */}
      {!loading && data && (
        <>
          {/* 合計カード（複数店舗時） */}
          {rows.length > 1 && (
            <s-box padding="base" paddingBlockStart="none">
              <s-card>
                <s-box padding="base">
                  <s-text variant="headingMd">合計</s-text>
                  <s-box paddingBlockStart="base">
                    {mode === "daily" ? (
                      <s-inline spacing="loose">
                        <MetricItem label="実績" value={fmtAmount(totals.actual)} large />
                        {totals.budget !== null && (
                          <MetricItem label="予算" value={fmtAmount(totals.budget)} />
                        )}
                        <MetricItem label="件数" value={`${fmtNum(totals.orders)}件`} />
                        {totals.visitors !== null && (
                          <MetricItem label="入店数" value={`${fmtNum(totals.visitors)}人`} />
                        )}
                      </s-inline>
                    ) : (
                      <s-inline spacing="loose">
                        <MetricItem label="月実績" value={fmtAmount(totals.actualTotal)} large />
                        {totals.budgetTotal !== null && (
                          <MetricItem label="月予算" value={fmtAmount(totals.budgetTotal)} />
                        )}
                        <MetricItem label="件数" value={`${fmtNum(totals.orders)}件`} />
                      </s-inline>
                    )}
                  </s-box>
                </s-box>
              </s-card>
            </s-box>
          )}

          {/* 店舗なし */}
          {rows.length === 0 && (
            <s-box padding="base">
              <s-text tone="subdued">
                売上サマリーが有効な店舗がありません。管理画面でロケーション設定を確認してください。
              </s-text>
            </s-box>
          )}

          {/* ロケーション別カード */}
          {rows.map((row) => (
            <s-box key={row.locationId} padding="base" paddingBlockStart="none">
              <s-card>
                <s-box padding="base">
                  <s-text variant="headingMd">{row.locationName}</s-text>
                  {mode === "daily" ? (
                    <DailyCard
                      row={row}
                      footfallInput={footfallInputs[row.locationId] ?? ""}
                      onFootfallChange={(v) =>
                        setFootfallInputs((s) => ({ ...s, [row.locationId]: v }))
                      }
                      onFootfallSave={() => handleSaveFootfall(row.locationId)}
                      saving={savingFootfall[row.locationId]}
                      footfallErr={footfallError[row.locationId]}
                    />
                  ) : (
                    <PeriodCard row={row} />
                  )}
                </s-box>
              </s-card>
            </s-box>
          ))}
        </>
      )}
    </s-page>
  );
}

// ── 日次カード ────────────────────────────────────────────────────────────────

function DailyCard({ row, footfallInput, onFootfallChange, onFootfallSave, saving, footfallErr }) {
  return (
    <s-box paddingBlockStart="base">
      {/* メイン指標 */}
      <s-inline spacing="loose" blockAlignment="center">
        <MetricItem label="実績" value={fmtAmount(row.actual)} large />
        {row.budget !== null && <MetricItem label="予算" value={fmtAmount(row.budget)} />}
        {row.budgetRatio !== null && (
          <MetricItem
            label="予算比"
            value={fmtPct(row.budgetRatio)}
            tone={row.budgetRatio >= 1 ? "success" : "critical"}
          />
        )}
      </s-inline>

      {/* KPI 指標 */}
      <s-box paddingBlockStart="base">
        <s-inline spacing="base">
          <MetricItem label="件数" value={`${fmtNum(row.orders)}件`} />
          {row.visitors !== null && (
            <MetricItem label="入店数" value={`${fmtNum(row.visitors)}人`} />
          )}
          {row.conv !== null && <MetricItem label="購買率" value={fmtPct(row.conv)} />}
          {row.atv !== null && <MetricItem label="客単価" value={fmtAmount(row.atv)} />}
          {row.setRate !== null && (
            <MetricItem label="セット率" value={fmtNum(row.setRate, 2)} />
          )}
          <MetricItem label="点数" value={`${fmtNum(row.items)}点`} />
          {row.unit !== null && <MetricItem label="一品単価" value={fmtAmount(row.unit)} />}
        </s-inline>
      </s-box>

      {/* 入店数入力（footfall 有効店舗のみ） */}
      {row.footfallReportingEnabled && (
        <s-box paddingBlockStart="base">
          <s-inline spacing="base" blockAlignment="end">
            <s-text-field
              label="入店数"
              value={footfallInput}
              onChange={(e) =>
                onFootfallChange(e.detail?.value ?? e.target?.value ?? footfallInput)
              }
            />
            <s-button onPress={onFootfallSave} disabled={saving}>
              {saving ? "保存中..." : "保存"}
            </s-button>
          </s-inline>
          {footfallErr && (
            <s-box paddingBlockStart="tight">
              <s-text tone="critical">{footfallErr}</s-text>
            </s-box>
          )}
        </s-box>
      )}
    </s-box>
  );
}

// ── 期間カード ────────────────────────────────────────────────────────────────

function PeriodCard({ row }) {
  return (
    <s-box paddingBlockStart="base">
      {/* メイン指標 */}
      <s-inline spacing="loose">
        <MetricItem label="月実績" value={fmtAmount(row.actualTotal)} large />
        {row.budgetTotal !== null && (
          <MetricItem label="月予算" value={fmtAmount(row.budgetTotal)} />
        )}
        {row.achievementRate !== null && (
          <MetricItem
            label="達成率"
            value={fmtPct(row.achievementRate)}
            tone={row.achievementRate >= 1 ? "success" : "critical"}
          />
        )}
      </s-inline>

      {/* 遂行予算・遂行率 */}
      {(row.progressBudgetToday > 0 || row.progressBudgetPrev > 0) && (
        <s-box paddingBlockStart="base">
          <s-inline spacing="base">
            {row.progressBudgetToday > 0 && (
              <>
                <MetricItem
                  label="遂行予算(当日)"
                  value={fmtAmount(row.progressBudgetToday)}
                />
                <MetricItem
                  label="遂行率(当日)"
                  value={fmtPct(row.progressRateToday)}
                  tone={row.progressRateToday >= 1 ? "success" : "critical"}
                />
              </>
            )}
            {row.progressBudgetPrev > 0 && (
              <>
                <MetricItem
                  label="遂行予算(前日)"
                  value={fmtAmount(row.progressBudgetPrev)}
                />
                <MetricItem
                  label="遂行率(前日)"
                  value={fmtPct(row.progressRatePrev)}
                  tone={row.progressRatePrev >= 1 ? "success" : "critical"}
                />
              </>
            )}
          </s-inline>
        </s-box>
      )}

      {/* 件数・点数 */}
      <s-box paddingBlockStart="base">
        <s-inline spacing="base">
          <MetricItem label="件数" value={`${fmtNum(row.orders)}件`} />
          <MetricItem label="点数" value={`${fmtNum(row.items)}点`} />
        </s-inline>
      </s-box>
    </s-box>
  );
}

// ── MetricItem ────────────────────────────────────────────────────────────────

function MetricItem({ label, value, large = false, tone }) {
  return (
    <s-box>
      <s-text tone="subdued" size="small">
        {label}
      </s-text>
      <s-text variant={large ? "headingMd" : "bodyMd"} tone={tone}>
        {value}
      </s-text>
    </s-box>
  );
}
