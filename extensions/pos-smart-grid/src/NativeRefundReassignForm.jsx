/**
 * POS 純正の返金の付け替え（特殊返金の登録画面。純正で返金した注文のとき）
 *
 * - 純正の返金を 1 件・支払方法 1 つずつ並べ、選ぶと金額はその返金額のまま。店の人は「実際に返した手段」だけ選ぶ
 * - 「分割」: 金額＋手段の行と、残額＋手段の行。「行を追加」で何行でも。最後の行は残額が自動で入る
 * - Shopify では返金しない（純正の返金がもうある）。精算は元の手段から実際の手段へ移すだけ
 * （T の決定 2026-11-23）
 */
import { useState, useEffect } from "preact/hooks";
import { PosChoiceField } from "./PosChoiceField.jsx";
import { createSpecialRefund, voidSpecialRefund } from "../../common/specialRefundApi.js";
import { listSelectablePaymentMethods } from "../../common/paymentMethodsApi.js";
import { toUserMessage } from "../../common/errorMessage.js";
import { refundEventTypeFor } from "../../common/refundModes.js";
import {
  allRowsHaveMethod,
  canReassign,
  nativeRefundLineLabel,
  nativeRefundLineStatus,
  splitAmounts,
} from "../../common/nativeRefundSplit.js";

function newKey() {
  return (
    globalThis?.crypto?.randomUUID?.() ??
    `pos-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  );
}

function yen(v) {
  return `¥${Number(v ?? 0).toLocaleString()}`;
}

function Row({ label, value }) {
  return (
    <s-stack direction="horizontal" align="space-between">
      <s-text tone="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-stack>
  );
}

const emptyRow = () => ({ amount: "", method: "" });

function sameGateway(a, b) {
  const ka = String(a ?? "").trim().toLowerCase();
  return ka !== "" && ka === String(b ?? "").trim().toLowerCase();
}

/** その純正の返金・支払方法の、有効な付け替えの登録（却下は数えない） */
export function activeReassignEvents(events, line) {
  return (events ?? []).filter(
    (e) =>
      e?.refundSource === "native" &&
      e?.status === "active" &&
      e?.approvalStatus !== "rejected" &&
      e?.shopifyRefundId === line?.refundId &&
      sameGateway(e?.originalPaymentMethod, line?.gateway),
  );
}

export function NativeRefundReassignForm({
  order,
  nativeRefunds,
  events = [],
  allowedEventTypes = null,
  loading,
  error,
  setLoading,
  setError,
  onBack,
  onOtherRegistration,
  onSuccess,
}) {
  const lines = Array.isArray(nativeRefunds) ? nativeRefunds : [];
  const [selected, setSelected] = useState(null);
  const [rows, setRows] = useState([emptyRow()]);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  // 行ごとの冪等キー（送り直しでも同じキー）。内容を変えたら作り直す
  const [keys, setKeys] = useState(null);
  const [refundMethods, setRefundMethods] = useState([]);
  const [refundMethodsState, setRefundMethodsState] = useState("loading");
  // 「付け替え直す」: 前の付け替えを無効にしてから、返金額の全額で選び直す
  const [redoLine, setRedoLine] = useState(null);

  useEffect(() => {
    listSelectablePaymentMethods({ sync: true })
      .then((res) => {
        const items = res.items ?? [];
        setRefundMethods(items);
        setRefundMethodsState(items.length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        setRefundMethods([]);
        setRefundMethodsState("error");
      });
  }, [order?.orderId]);

  useEffect(() => {
    setKeys(null);
  }, [selected?.refundId, selected?.gateway, rows, note]);

  const split = rows.length > 1;
  const total = Number(selected?.remaining ?? 0);
  const amounts = splitAmounts(total, rows);

  const setRow = (i, patch) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const startSplit = () => setRows((prev) => [{ amount: "", method: prev[0]?.method ?? "" }, emptyRow()]);
  // 「行を追加」: 最後（残額）の行の前に、金額を入れる行を足す
  const addRow = () => setRows((prev) => [...prev.slice(0, -1), emptyRow(), prev[prev.length - 1]]);
  const removeRow = (i) => setRows((prev) => (prev.length <= 2 ? [prev[prev.length - 1]] : prev.filter((_, j) => j !== i)));
  const stopSplit = () => setRows((prev) => [{ amount: "", method: prev[prev.length - 1]?.method ?? "" }]);

  const methodsMessage =
    refundMethodsState === "loading"
      ? "支払方法を読み込み中…"
      : refundMethodsState === "error"
        ? "支払方法を読み込めませんでした。通信を確かめて、この画面を開き直してください。"
        : refundMethodsState === "empty"
          ? "特殊返金で選べる支払方法がありません。管理画面の「支払方法」で登録してください。"
          : "";
  const methodLabel = (v) => refundMethods.find((m) => m.value === v)?.label ?? v ?? "-";

  const handleConfirm = () => {
    setError("");
    if (!amounts.ok) {
      setError(amounts.error);
      return;
    }
    if (!allRowsHaveMethod(rows, refundMethods)) {
      setError(methodsMessage || "返金方法を選んでください");
      return;
    }
    if (!keys) setKeys(rows.map(() => newKey()));
    setConfirming(true);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    const rowKeys = keys ?? rows.map(() => newKey());
    if (!keys) setKeys(rowKeys);
    let done = 0;
    let lastRes = null;
    try {
      for (let i = 0; i < rows.length; i++) {
        lastRes = await createSpecialRefund({
          idempotencyKey: rowKeys[i],
          sourceOrderId: order.orderId,
          sourceOrderName: order.orderName,
          locationId: order.location?.id ?? "",
          eventType: refundEventTypeFor("method", rows[i].method, refundMethods, allowedEventTypes),
          amount: amounts.amounts[i],
          currency: order.totalPrice?.currencyCode ?? "JPY",
          originalPaymentMethod: selected.gateway,
          actualRefundMethod: rows[i].method,
          nativeRefundId: selected.refundId,
          note: note.trim() || null,
        });
        done += 1;
      }
      setConfirming(false);
      const parts = [`返金方法を変更しました（${yen(total)}・${rows.length} 行）。Shopify では返金していません。`];
      if (lastRes?.approvalRequired) parts.push("管理者の承認待ちです。承認されるまで精算では元の支払方法のままです。");
      if (lastRes?.metafieldWritten === false) parts.push("注文への記録はまだ書けていません。あとで開き直すと書き直します。");
      await onSuccess({ tone: "success", text: parts.join(" ") });
    } catch (e) {
      const msg = toUserMessage(e?.message) || "登録に失敗しました";
      setConfirming(false);
      if (done > 0) {
        await onSuccess({
          tone: "warning",
          text: `${rows.length} 行のうち ${done} 行の返金方法を変更しました。残りは登録できませんでした（${msg}）。注文を開き直して、残りの返金方法を変更してください。`,
        });
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const runRedo = async () => {
    if (!redoLine) return;
    setLoading(true);
    setError("");
    const targets = activeReassignEvents(events, redoLine);
    let voided = 0;
    try {
      for (const e of targets) {
        await voidSpecialRefund(e.id, { reason: "返金方法の変更し直し" });
        voided += 1;
      }
      setSelected({ ...redoLine, remaining: redoLine.amount, reassigned: 0 });
      setRows([emptyRow()]);
      setRedoLine(null);
    } catch (e) {
      const msg = toUserMessage(e?.message) || "無効にできませんでした";
      setRedoLine(null);
      await onSuccess({
        tone: "warning",
        text:
          voided > 0
            ? `前の返金方法変更 ${targets.length} 件のうち ${voided} 件を無効にしました。残りは無効にできませんでした（${msg}）。注文を開き直して、もう一度「変更し直す」を押してください。`
            : `前の返金方法変更を無効にできませんでした（${msg}）。`,
      });
    } finally {
      setLoading(false);
    }
  };

  // ── 付け替え直すの確認 ──
  if (redoLine) {
    const targets = activeReassignEvents(events, redoLine);
    return (
      <s-page heading="返金方法を変更し直す">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-text type="strong">前の返金方法変更を無効にして、選び直します</s-text>
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="純正の返金" value={nativeRefundLineLabel(redoLine)} />
                  {targets.map((e) => (
                    <Row
                      key={e.id}
                      label={`${e.originalPaymentLabel || e.originalPaymentMethod} → ${e.actualRefundLabel || e.actualRefundMethod}`}
                      value={yen(e.amount)}
                    />
                  ))}
                </s-stack>
              </s-box>
              <s-text type="small" color="subdued">
                無効にした分は、いったん元の支払方法の返金に戻ります。続けて返金方法を選んでください。Shopify では何もしません。
              </s-text>
              {error ? <s-text tone="critical">{error}</s-text> : null}
              <s-stack gap="small">
                <s-button variant="primary" onClick={runRedo} loading={loading} disabled={targets.length === 0}>
                  無効にして選び直す
                </s-button>
                <s-button variant="secondary" onClick={() => setRedoLine(null)} disabled={loading}>
                  戻る
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ── 確認 ──
  if (confirming && selected) {
    return (
      <s-page heading="返金方法変更">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-text type="strong">この内容で返金方法を変更します</s-text>
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="取引" value={order?.orderName ?? "-"} />
                  <Row label="純正の返金" value={nativeRefundLineLabel(selected)} />
                  {rows.map((r, i) => (
                    <Row
                      key={i}
                      label={
                        String(r.method ?? "").trim().toLowerCase() === String(selected.gateway ?? "").trim().toLowerCase() ||
                        methodLabel(r.method) === (selected.label || selected.gateway)
                          ? `${methodLabel(r.method)}のまま（変更なし）`
                          : `${selected.label || selected.gateway} → ${methodLabel(r.method)}`
                      }
                      value={yen(amounts.amounts[i])}
                    />
                  ))}
                  <Row label="合計" value={yen(total)} />
                  {note ? <Row label="メモ" value={note} /> : null}
                </s-stack>
              </s-box>
              <s-text type="small" color="subdued">
                Shopify では返金しません。精算では、この返金を元の支払方法から選んだ返金方法へ移します（返金の合計は変わりません）。
              </s-text>
              {error ? <s-text tone="critical">{error}</s-text> : null}
              <s-stack gap="small">
                <s-button variant="primary" onClick={handleSubmit} loading={loading}>
                  変更する
                </s-button>
                <s-button variant="secondary" onClick={() => setConfirming(false)} disabled={loading}>
                  修正する
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ── 手段を選ぶ（分割） ──
  if (selected) {
    return (
      <s-page heading="返金方法変更">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="純正の返金" value={nativeRefundLineLabel(selected)} />
                  <Row label="変更する額" value={yen(total)} />
                </s-stack>
              </s-box>

              {refundMethods.length === 0 ? (
                <s-text tone={refundMethodsState === "loading" ? "subdued" : "critical"} type="small">
                  {methodsMessage}
                </s-text>
              ) : !split ? (
                <PosChoiceField
                  label="返金方法"
                  value={rows[0].method}
                  options={refundMethods}
                  onChange={(v) => setRow(0, { method: v })}
                />
              ) : (
                rows.map((r, i) => {
                  const isLast = i === rows.length - 1;
                  return (
                    <s-box key={i} padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                      <s-stack gap="small">
                        {isLast ? (
                          <Row label={`${i + 1} 行目（残額・自動）`} value={amounts.lastAmount > 0 ? yen(amounts.lastAmount) : "-"} />
                        ) : (
                          <s-text-field
                            label={`${i + 1} 行目の金額（円）`}
                            value={r.amount}
                            type="number"
                            onInput={(e) => setRow(i, { amount: e?.currentTarget?.value ?? "" })}
                            placeholder="例: 1000"
                          />
                        )}
                        <PosChoiceField
                          label="返金方法"
                          value={r.method}
                          options={refundMethods}
                          onChange={(v) => setRow(i, { method: v })}
                        />
                        {!isLast ? (
                          <s-button variant="secondary" onClick={() => removeRow(i)} disabled={loading}>
                            この行を消す
                          </s-button>
                        ) : null}
                      </s-stack>
                    </s-box>
                  );
                })
              )}

              {refundMethods.length > 0 ? (
                split ? (
                  <s-stack gap="small">
                    <s-button variant="secondary" onClick={addRow} disabled={loading}>
                      行を追加
                    </s-button>
                    <s-button variant="secondary" onClick={stopSplit} disabled={loading}>
                      分割をやめる
                    </s-button>
                  </s-stack>
                ) : (
                  <s-button variant="secondary" onClick={startSplit} disabled={loading}>
                    分割
                  </s-button>
                )
              ) : null}

              <s-text-field
                label="メモ（任意）"
                value={note}
                onInput={(e) => setNote(e?.currentTarget?.value ?? "")}
                placeholder="補足説明など"
              />

              {error ? <s-text tone="critical">{error}</s-text> : null}

              <s-stack gap="small">
                <s-button variant="primary" onClick={handleConfirm} disabled={loading || refundMethods.length === 0}>
                  確認する
                </s-button>
                <s-button
                  variant="secondary"
                  onClick={() => {
                    setError("");
                    setSelected(null);
                    setRows([emptyRow()]);
                  }}
                  disabled={loading}
                >
                  戻る
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  // ── 純正の返金を選ぶ ──
  const anyOpen = lines.some(canReassign);
  return (
    <s-page heading="返金方法変更">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text type="small" color="subdued">
              {`${order?.orderName ?? "この取引"} は POS で返金されています。返金方法を変更する返金を選んでください。金額は返金した額のままです。`}
            </s-text>
            {lines.map((line) => {
              const status = nativeRefundLineStatus(line);
              return (
                <s-box key={`${line.refundId}:${line.gateway}`} padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                    <s-stack gap="none">
                      <s-text type="strong">{nativeRefundLineLabel(line)}</s-text>
                      {status ? <s-text type="small" color="subdued">{status}</s-text> : null}
                    </s-stack>
                    <s-stack gap="small">
                      {canReassign(line) ? (
                        <s-button
                          variant="secondary"
                          onClick={() => {
                            setError("");
                            setSelected(line);
                            setRows([emptyRow()]);
                          }}
                          disabled={loading}
                        >
                          返金方法を変更
                        </s-button>
                      ) : null}
                      {activeReassignEvents(events, line).length > 0 ? (
                        <s-button
                          variant="secondary"
                          onClick={() => {
                            setError("");
                            setRedoLine(line);
                          }}
                          disabled={loading}
                        >
                          変更し直す
                        </s-button>
                      ) : null}
                    </s-stack>
                  </s-stack>
                </s-box>
              );
            })}
            {!anyOpen ? (
              <s-text type="small" color="subdued">
                この取引の返金はすべて返金方法変更済みです。返金方法や分け方を直すときは「変更し直す」、返金方法だけなら調整履歴の「変更」を使ってください。
              </s-text>
            ) : null}
            {error ? <s-text tone="critical">{error}</s-text> : null}
            <s-stack gap="small">
              {onOtherRegistration ? (
                <s-button variant="secondary" onClick={onOtherRegistration} disabled={loading}>
                  レシートの現金を直す
                </s-button>
              ) : null}
              <s-button variant="secondary" onClick={onBack} disabled={loading}>
                戻る
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
