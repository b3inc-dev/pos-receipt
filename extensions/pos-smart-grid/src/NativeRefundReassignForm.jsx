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
import { createSpecialRefund } from "../../common/specialRefundApi.js";
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

export function NativeRefundReassignForm({
  order,
  nativeRefunds,
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
      setError(methodsMessage || "実際に返した手段を選んでください");
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
      const parts = [`付け替えました（${yen(total)}・${rows.length} 行）。Shopify では返金していません。`];
      if (lastRes?.approvalRequired) parts.push("管理者の承認待ちです。承認されるまで精算では元の支払方法のままです。");
      if (lastRes?.metafieldWritten === false) parts.push("注文への記録はまだ書けていません。あとで開き直すと書き直します。");
      await onSuccess({ tone: "success", text: parts.join(" ") });
    } catch (e) {
      const msg = toUserMessage(e?.message) || "登録に失敗しました";
      setConfirming(false);
      if (done > 0) {
        await onSuccess({
          tone: "warning",
          text: `${rows.length} 行のうち ${done} 行を付け替えました。残りは登録できませんでした（${msg}）。注文を開き直して、残りを付け替えてください。`,
        });
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  // ── 確認 ──
  if (confirming && selected) {
    return (
      <s-page heading="付け替えの確認">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-text fontWeight="bold">以下の内容で付け替えます</s-text>
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="取引" value={order?.orderName ?? "-"} />
                  <Row label="純正の返金" value={nativeRefundLineLabel(selected)} />
                  {rows.map((r, i) => (
                    <Row key={i} label={`${selected.label || selected.gateway} → ${methodLabel(r.method)}`} value={yen(amounts.amounts[i])} />
                  ))}
                  <Row label="合計" value={yen(total)} />
                  {note ? <Row label="メモ" value={note} /> : null}
                </s-stack>
              </s-box>
              <s-text tone="subdued" fontSize="small">
                Shopify では返金しません。精算では、この返金を元の支払方法から選んだ手段へ移します（返金の合計は変わりません）。
              </s-text>
              {error ? <s-text tone="critical">{error}</s-text> : null}
              <s-stack gap="small">
                <s-button kind="primary" onClick={handleSubmit} loading={loading}>
                  付け替える
                </s-button>
                <s-button kind="secondary" onClick={() => setConfirming(false)} disabled={loading}>
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
      <s-page heading="返金の手段を付け替える">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="純正の返金" value={nativeRefundLineLabel(selected)} />
                  <Row label="付け替える額" value={yen(total)} />
                </s-stack>
              </s-box>

              {refundMethods.length === 0 ? (
                <s-text tone={refundMethodsState === "loading" ? "subdued" : "critical"} fontSize="small">
                  {methodsMessage}
                </s-text>
              ) : !split ? (
                <PosChoiceField
                  label="実際に返した手段"
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
                          label="返した手段"
                          value={r.method}
                          options={refundMethods}
                          onChange={(v) => setRow(i, { method: v })}
                        />
                        {!isLast ? (
                          <s-button kind="secondary" onClick={() => removeRow(i)} disabled={loading}>
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
                    <s-button kind="secondary" onClick={addRow} disabled={loading}>
                      行を追加
                    </s-button>
                    <s-button kind="secondary" onClick={stopSplit} disabled={loading}>
                      分割をやめる
                    </s-button>
                  </s-stack>
                ) : (
                  <s-button kind="secondary" onClick={startSplit} disabled={loading}>
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
                <s-button kind="primary" onClick={handleConfirm} disabled={loading || refundMethods.length === 0}>
                  確認する
                </s-button>
                <s-button
                  kind="secondary"
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
    <s-page heading="返金の手段を付け替える">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text tone="subdued" fontSize="small">
              {`${order?.orderName ?? "この取引"} は POS で返金されています。付け替える返金を選んでください。金額は返金した額のままです。`}
            </s-text>
            {lines.map((line) => {
              const status = nativeRefundLineStatus(line);
              return (
                <s-box key={`${line.refundId}:${line.gateway}`} padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                    <s-stack gap="none">
                      <s-text fontWeight="bold">{nativeRefundLineLabel(line)}</s-text>
                      {status ? <s-text tone="subdued" fontSize="small">{status}</s-text> : null}
                    </s-stack>
                    <s-button
                      kind="secondary"
                      onClick={() => {
                        setError("");
                        setSelected(line);
                        setRows([emptyRow()]);
                      }}
                      disabled={loading || !canReassign(line)}
                    >
                      付け替える
                    </s-button>
                  </s-stack>
                </s-box>
              );
            })}
            {!anyOpen ? (
              <s-text tone="subdued" fontSize="small">
                この取引の返金はすべて付け替え済みです。直すときは調整履歴の「変更」を使ってください。
              </s-text>
            ) : null}
            {error ? <s-text tone="critical">{error}</s-text> : null}
            <s-stack gap="small">
              {onOtherRegistration ? (
                <s-button kind="secondary" onClick={onOtherRegistration} disabled={loading}>
                  レシートの現金を直す
                </s-button>
              ) : null}
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
