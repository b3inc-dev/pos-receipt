/**
 * 精算モーダル
 * 要件書 §6, §23.1
 *
 * Steps:
 *   main     → ロケーション選択・日付選択・アクションボタン
 *   preview  → 精算プレビュー（集計結果表示）
 *   confirm  → 実行確認
 *   done     → 完了（印字方式別メッセージ）
 *   history  → 精算履歴
 */
import { render } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import {
  getLocations,
  previewSettlement,
  createSettlement,
  recalculateSettlement,
  getSettlementHistory,
} from "../../common/settlementApi.js";
import { getAppUrl, isDevApiUrl, setApiBaseOverride, getApiBaseOverride } from "../../common/appUrl.js";
import { getLocationsFromShopify } from "../../common/shopifyAdminGraphql.js";
import { getSessionLocation } from "../../common/sessionLocation.js";
import { toUserMessage } from "../../common/errorMessage.js";

// ── 今日の日付（YYYY-MM-DD） ────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  /** 精算プレビュー失敗時に接続先と GraphQL 修正有無を表示する用 */
  const [previewErrorDiagnostic, setPreviewErrorDiagnostic] = useState(null);

  // POS Stock と同様: まず Shopify 内蔵 API でロケーション取得（バックエンド不要・Load failed 防止）
  // その後バックエンドで printMode 等を取得してマージ。バックエンド失敗時はデフォルトのまま表示
  const loadLocations = useCallback(() => {
    setLoading(true);
    setLocationLoadError("");
    getLocationsFromShopify(50)
      .then((res) => {
        let locs = res.locations ?? [];
        const { locationGid } = getSessionLocation();
        if (locationGid) {
          locs = locs.filter((l) => l.locationId === locationGid);
        }
        setLocations(locs);
        const initial = locationGid ? locs.find((l) => l.locationId === locationGid) ?? locs[0] : locs[0];
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

  useEffect(() => { loadLocations(); }, []);

  const handlePreview = useCallback(
    async (inspection = false) => {
      if (!selectedLocation) return;
      setLoading(true);
      setError("");
      setPreviewErrorDiagnostic(null);
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
        const baseUrl = getAppUrl();
        setPreviewErrorDiagnostic({ baseUrl, graphqlFixed: null, pingFailed: false });
        fetch(`${baseUrl}/api/locations?ping=1`)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((d) => {
            setPreviewErrorDiagnostic((prev) =>
              prev
                ? {
                    ...prev,
                    graphqlFixed: d.graphqlTransactionsUseNodes === true,
                    diagnosticVersion: d.diagnosticVersion ?? null,
                  }
                : null
            );
          })
          .catch(() => {
            setPreviewErrorDiagnostic((prev) => (prev ? { ...prev, pingFailed: true } : null));
          });
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

  if (step === "main") {
    return (
      <MainView
        locations={locations}
        selectedLocation={selectedLocation}
        targetDate={targetDate}
        loading={loading}
        error={error}
        locationLoadError={locationLoadError}
        previewErrorDiagnostic={previewErrorDiagnostic}
        onSelectLocation={(loc) => setSelectedLocation(loc)}
        onDateChange={(d) => setTargetDate(d)}
        onPreview={() => handlePreview(false)}
        onInspection={() => handlePreview(true)}
        onHistory={() => setStep("history")}
        onRetryLocations={loadLocations}
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

  if (step === "history") {
    return (
      <HistoryView
        selectedLocation={selectedLocation}
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
  targetDate,
  loading,
  error,
  locationLoadError,
  previewErrorDiagnostic,
  onSelectLocation,
  onDateChange,
  onPreview,
  onInspection,
  onHistory,
  onRetryLocations,
  setError,
}) {
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState(null);
  const [diagError, setDiagError] = useState(null);
  const [devUrlInput, setDevUrlInput] = useState("");
  const apiOverride = getApiBaseOverride();

  const runConnectionCheck = useCallback(() => {
    setDiagOpen(true);
    setDiagLoading(true);
    setDiagError(null);
    setDiagResult(null);
    const base = getAppUrl();
    fetch(`${base}/api/locations?ping=1`)
      .then((r) => r.json())
      .then((data) => {
        setDiagResult(data);
        setDiagLoading(false);
      })
      .catch((e) => {
        setDiagError(e?.message ?? "接続できません");
        setDiagLoading(false);
      });
  }, []);

  const handleLocChange = (e) => {
    const id = e?.currentTarget?.value ?? e?.currentValue?.value;
    const loc = locations.find((l) => l.locationId === id);
    if (loc) onSelectLocation(loc);
  };

  return (
    <s-page heading="精算">
      <s-scroll-box>
        <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
          <s-stack gap="small">
            <s-text fontWeight="bold" fontSize="small">開発時: 接続先</s-text>
            <s-text tone="subdued" fontSize="small">いま: {getAppUrl()}</s-text>
            {apiOverride ? (
              <s-stack gap="extraSmall">
                <s-text tone="success" fontSize="small">固定中: {apiOverride}</s-text>
                <s-button kind="plain" onClick={() => { setApiBaseOverride(""); setDevUrlInput(""); }}>解除</s-button>
              </s-stack>
            ) : (
              <s-stack gap="extraSmall">
                <s-text-field label="トンネルURL" value={devUrlInput} onInput={(e) => setDevUrlInput(e?.currentTarget?.value ?? "")} />
                <s-button kind="secondary" disabled={!devUrlInput.trim()} onClick={() => { const u = devUrlInput.trim().replace(/\/$/, ""); if (u) setApiBaseOverride(u); }}>開発サーバーを使う</s-button>
              </s-stack>
            )}
          </s-stack>
        </s-box>
        <s-box padding="base">
          <s-stack gap="base">

            {/* ロケーション選択 */}
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
                  <s-text tone="subdued" fontSize="small">
                    印字方式: {selectedLocation.printMode === "cloudprnt_direct" ? "CloudPRNT直印字" : "注文経由印字"}
                  </s-text>
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

            {/* 対象日 */}
            <s-text-field
              label="対象日 (YYYY-MM-DD)"
              value={targetDate}
              onInput={(e) => { setError(""); onDateChange(e?.currentTarget?.value ?? targetDate); }}
            />

            {error ? (
              <s-stack gap="small">
                <s-text tone="critical">{error}</s-text>
                {previewErrorDiagnostic ? (
                  <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="critical">
                    <s-stack gap="small">
                      <s-text fontWeight="bold" fontSize="small">原因の切り分け</s-text>
                      <s-text tone="subdued" fontSize="small">接続先: {previewErrorDiagnostic.baseUrl}</s-text>
                      {previewErrorDiagnostic.pingFailed ? (
                        <s-text tone="critical" fontSize="small">
                          接続先の応答を取得できませんでした。ブラウザで「{previewErrorDiagnostic.baseUrl}/api/locations?ping=1」を開き、JSON が返るか確認してください。デプロイ以外（キャッシュ・ネットワーク・CORS）の可能性もあります。
                        </s-text>
                      ) : (
                        <>
                          <s-text
                            fontSize="small"
                            tone={
                              previewErrorDiagnostic.graphqlFixed === null
                                ? "subdued"
                                : previewErrorDiagnostic.graphqlFixed
                                  ? "success"
                                  : "critical"
                            }
                          >
                            GraphQL修正済み:{" "}
                            {previewErrorDiagnostic.graphqlFixed === null
                              ? "確認中…"
                              : previewErrorDiagnostic.graphqlFixed
                                ? "はい"
                                : "いいえ"}
                          </s-text>
                          {previewErrorDiagnostic.diagnosticVersion ? (
                            <s-text tone="subdued" fontSize="small">
                              サーバー表示バージョン: {previewErrorDiagnostic.diagnosticVersion}
                            </s-text>
                          ) : null}
                          {previewErrorDiagnostic.graphqlFixed === false ? (
                        <s-text tone="critical" fontSize="small">
                          {isDevApiUrl(previewErrorDiagnostic.baseUrl)
                            ? "→ 開発サーバーに修正が反映されていません。npm run dev:clean で開発サーバーを再起動し、トンネルURLを開き直してください。"
                            : "→ 本番サーバーに修正が反映されていません。Render の「Clear build cache & deploy」で再デプロイしてください。"}
                        </s-text>
                      ) : null}
                        </>
                      )}
                    </s-stack>
                  </s-box>
                ) : null}
              </s-stack>
            ) : null}

            {/* アクションボタン */}
            <s-stack gap="small">
              <s-button
                kind="primary"
                onClick={onPreview}
                loading={loading}
                disabled={!selectedLocation}
              >
                精算プレビュー
              </s-button>
              <s-button
                kind="secondary"
                onClick={onInspection}
                loading={loading}
                disabled={!selectedLocation}
              >
                点検レシート
              </s-button>
              <s-button kind="plain" onClick={onHistory}>
                精算履歴
              </s-button>
            </s-stack>

            {/* 接続・バージョン確認（タイル上で切り分け用） */}
            <s-stack gap="small">
              <s-button kind="plain" onClick={runConnectionCheck}>
                接続・バージョン確認
              </s-button>
              {diagOpen ? (
                <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack gap="small">
                    <s-text fontWeight="bold" fontSize="small">接続先</s-text>
                    <s-text tone="subdued" fontSize="small" wrap="wrap">{getAppUrl()}</s-text>
                    {diagLoading ? (
                      <s-text tone="subdued" fontSize="small">確認中…</s-text>
                    ) : diagError ? (
                      <s-text tone="critical" fontSize="small">{diagError}</s-text>
                    ) : diagResult ? (
                      <s-stack gap="extraSmall">
                        <s-text fontSize="small">
                          応答: {diagResult.ok ? "OK" : "エラー"}
                        </s-text>
                        <s-text fontSize="small" tone={diagResult.graphqlTransactionsUseNodes ? "success" : "critical"}>
                          GraphQL修正済み: {diagResult.graphqlTransactionsUseNodes ? "はい" : "いいえ"}
                        </s-text>
                        {diagResult.diagnosticVersion ? (
                          <s-text tone="subdued" fontSize="small">
                            サーバー表示バージョン: {diagResult.diagnosticVersion}
                          </s-text>
                        ) : null}
                        {!diagResult.graphqlTransactionsUseNodes ? (
                          <s-text tone="subdued" fontSize="small">
                            {isDevApiUrl(getAppUrl())
                              ? "精算プレビュー500の場合は開発サーバーを npm run dev:clean で再起動してください。"
                              : "精算プレビュー500の場合は本番を Render の「Clear build cache & deploy」で再デプロイしてください。"}
                          </s-text>
                        ) : null}
                      </s-stack>
                    ) : null}
                  </s-stack>
                </s-box>
              ) : null}
            </s-stack>

          </s-stack>
        </s-box>
      </s-scroll-box>
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

            {/* 支払方法別内訳 */}
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
function HistoryView({ selectedLocation, onBack }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selectedLocation) { setLoading(false); return; }
    getSettlementHistory({ locationId: selectedLocation.locationId, limit: 20 })
      .then((res) => setItems(res.items ?? []))
      .catch((e) => setError(toUserMessage(e?.message) || "履歴の取得に失敗しました"))
      .finally(() => setLoading(false));
  }, [selectedLocation?.locationId]);

  const STATUS_LABELS = {
    draft: "下書き",
    completed: "完了",
    printed: "印刷済み",
    failed: "失敗",
  };

  return (
    <s-page heading="精算履歴">
      <s-scroll-box>
        <s-box padding="base">
          {loading ? (
            <s-text tone="subdued">読み込み中…</s-text>
          ) : error ? (
            <s-text tone="critical">{error}</s-text>
          ) : items.length === 0 ? (
            <s-text tone="subdued">精算履歴がありません。</s-text>
          ) : (
            <s-stack gap="small">
              {items.map((item) => (
                <s-box
                  key={item.id}
                  padding="small"
                  borderWidth="base"
                  borderRadius="base"
                  borderColor="subdued"
                >
                  <s-stack gap="extraSmall">
                    <s-stack direction="horizontal" align="space-between">
                      <s-text fontWeight="bold">{item.targetDate}</s-text>
                      <s-text fontWeight="bold">¥{Number(item.total).toLocaleString()}</s-text>
                    </s-stack>
                    <s-stack direction="horizontal" align="space-between">
                      <s-text tone="subdued" fontSize="small">
                        {item.orderCount}件 / {item.itemCount}点
                        {item.periodLabel?.startsWith("点検_") ? " 【点検】" : ""}
                      </s-text>
                      <s-text tone="subdued" fontSize="small">
                        {STATUS_LABELS[item.status] ?? item.status}
                      </s-text>
                    </s-stack>
                    <s-text tone="subdued" fontSize="small">
                      {item.printMode === "order_based"
                        ? `注文: ${item.sourceOrderName ?? "-"}`
                        : "CloudPRNT"}
                    </s-text>
                  </s-stack>
                </s-box>
              ))}
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
