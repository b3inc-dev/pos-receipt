/**
 * 返金の手段を先に決める（返金の予約）。まだ純正で返金していない注文で、返金の前に開く画面。
 *
 * - 「実際に返す手段」を選んで予約する（分割可・最後の行は残り＝純正で返金した額から自動）
 * - そのあと、いつもどおり POS 純正で返品・返金する。返金ができたら、アプリが付け替えを自動で作る
 *   （金額は純正の返金額で固定・Shopify では返金しない）
 * - 予約はその日の営業が終わると使わない。ここで取り消しもできる
 * docs/REFUND_RESERVATION.md（T の決定 2026-11-23）
 */
import { useState, useEffect, useCallback } from "preact/hooks";
import { PosChoiceField } from "./PosChoiceField.jsx";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";
import {
  listRefundReservations,
  createRefundReservation,
  cancelRefundReservation,
} from "../../common/specialRefundApi.js";
import { listSelectablePaymentMethods } from "../../common/paymentMethodsApi.js";
import { toUserMessage } from "../../common/errorMessage.js";
import { refundEventTypeFor } from "../../common/refundModes.js";
import {
  reservationExpectedAmountFromInput,
  reservationRowsFromInput,
  reservationRowText,
  reservationStatusLabel,
  reservationStatusTone,
} from "../../common/refundReservation.js";

const emptyRow = () => ({ amount: "", method: "" });

function ReservationCard({ item, onCancel, loading }) {
  const canCancel = item.status === "pending" || item.status === "needs_review";
  return (
    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack gap="small">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-badge tone={reservationStatusTone(item.status)}>{reservationStatusLabel(item.status)}</s-badge>
          {canCancel ? (
            <s-button tone="critical" onClick={() => onCancel(item.id)} disabled={loading}>
              取り消す
            </s-button>
          ) : null}
        </s-stack>
        {item.expectedAmount ? <s-text>{`返金する金額 ¥${Number(item.expectedAmount).toLocaleString()}`}</s-text> : null}
        {(item.rows ?? []).map((row, i) => (
          <s-text key={i}>{reservationRowText(row)}</s-text>
        ))}
        {item.status === "pending" ? (
          <s-text tone="neutral">このあと POS で同じ金額を返金すると、自動でこの手段に付け替えます。金額が違うときは「要確認」になります。</s-text>
        ) : null}
        {item.status === "applied" ? (
          <s-text tone="neutral">純正の返金に付け替えました。調整履歴に出ています。</s-text>
        ) : null}
        {item.status === "needs_review" && item.reviewReason ? <s-text tone="caution">{item.reviewReason}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

export function RefundReservationForm({ order, allowedEventTypes = null, onBack, onOtherRegistration, onApplied }) {
  const [items, setItems] = useState([]);
  const [state, setState] = useState("loading");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rows, setRows] = useState([emptyRow()]);
  const [note, setNote] = useState("");
  const [expected, setExpected] = useState("");
  const [methods, setMethods] = useState([]);
  const [methodsState, setMethodsState] = useState("loading");

  const reload = useCallback(async () => {
    if (!order?.orderId) return;
    try {
      const res = await listRefundReservations(order.orderId);
      // 管理画面で「返金の予約」がオフ: この画面は出さずに、今までの登録の画面へ
      if (res.enabled === false && onOtherRegistration) {
        onOtherRegistration();
        return;
      }
      const list = res.items ?? [];
      setItems(list);
      setState("ready");
      if (res.applyError) setError(res.applyError);
      if (list.some((r) => r.status === "applied") && onApplied) onApplied();
    } catch (e) {
      setState("error");
      setError(toUserMessage(e?.message) || "予約を読み込めませんでした");
    }
  }, [order?.orderId]);

  useEffect(() => {
    reload();
    listSelectablePaymentMethods({ sync: true })
      .then((res) => {
        const list = res.items ?? [];
        setMethods(list);
        setMethodsState(list.length > 0 ? "ready" : "empty");
      })
      .catch(() => setMethodsState("error"));
  }, [reload]);

  const open = items.find((r) => r.status === "pending" || r.status === "needs_review") ?? null;
  const recent = items.filter((r) => r !== open).slice(0, 3);
  const split = rows.length > 1;
  const setRow = (i, patch) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const startSplit = () => setRows((prev) => [{ amount: "", method: prev[0]?.method ?? "" }, emptyRow()]);
  const addRow = () => setRows((prev) => [...prev.slice(0, -1), emptyRow(), prev[prev.length - 1]]);
  const removeRow = (i) => setRows((prev) => (prev.length <= 2 ? [prev[prev.length - 1]] : prev.filter((_, j) => j !== i)));
  const stopSplit = () => setRows((prev) => [{ amount: "", method: prev[prev.length - 1]?.method ?? "" }]);

  const methodsMessage =
    methodsState === "loading"
      ? "支払方法を読み込み中…"
      : methodsState === "error"
        ? "支払方法を読み込めませんでした。通信を確かめて、この画面を開き直してください。"
        : methodsState === "empty"
          ? "特殊返金で選べる支払方法がありません。管理画面の「支払方法」で登録してください。"
          : "";

  const submit = async () => {
    setError("");
    setNotice("");
    const parsed = reservationRowsFromInput(rows);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const exp = reservationExpectedAmountFromInput(expected, parsed.rows);
    if (!exp.ok) {
      setError(exp.error);
      return;
    }
    setLoading(true);
    try {
      await createRefundReservation({
        sourceOrderId: order.orderId,
        sourceOrderName: order.orderName,
        locationId: order.location?.id ?? "",
        expectedAmount: exp.amount,
        rows: parsed.rows.map((r) => ({
          ...r,
          eventType: refundEventTypeFor("method", r.actualRefundMethod, methods, allowedEventTypes),
        })),
        note: note.trim() || null,
      });
      setRows([emptyRow()]);
      setNote("");
      setExpected("");
      setNotice("予約しました。このあと、いつもどおり POS で返品・返金してください。");
      await reload();
    } catch (e) {
      setError(toUserMessage(e?.message) || "予約できませんでした");
    } finally {
      setLoading(false);
    }
  };

  const cancel = async (id) => {
    setError("");
    setNotice("");
    setLoading(true);
    try {
      await cancelRefundReservation(id);
      setNotice("予約を取り消しました。");
      await reload();
    } catch (e) {
      setError(toUserMessage(e?.message) || "取り消せませんでした");
    } finally {
      setLoading(false);
    }
  };

  return (
    <s-page heading="返金の手段を先に決める">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {error ? <s-banner tone="critical">{error}</s-banner> : notice ? <s-banner tone="success">{notice}</s-banner> : null}
            <s-text tone="neutral">
              {`${order?.orderName ?? "この取引"} をこれから POS で返金するときに、実際に返す手段を先に決めておけます。返金が終わると、返金した額のまま自動で付け替えます。Shopify では返金しません。`}
            </s-text>

            {state === "loading" ? <s-text tone="neutral">読み込み中…</s-text> : null}

            {open ? (
              <ReservationCard item={open} onCancel={cancel} loading={loading} />
            ) : state === "ready" ? (
              <s-section heading="実際に返す手段">
                <s-stack gap="small">
                  <s-text-field
                    label="返金する金額（円）"
                    value={expected}
                    type="number"
                    onInput={(e) => setExpected(e?.currentTarget?.value ?? "")}
                    placeholder="例: 2500"
                  />
                  {methods.length === 0 ? (
                    <s-text tone={methodsState === "loading" ? "subdued" : "critical"}>{methodsMessage}</s-text>
                  ) : !split ? (
                    <PosChoiceField
                      label="返す手段"
                      value={rows[0].method}
                      options={methods}
                      onChange={(v) => setRow(0, { method: v })}
                    />
                  ) : (
                    rows.map((r, i) => {
                      const isLast = i === rows.length - 1;
                      return (
                        <s-box key={i} padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                          <s-stack gap="small">
                            {isLast ? (
                              <s-text tone="neutral">{`${i + 1} 行目（残り・返金した額から自動）`}</s-text>
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
                              label="返す手段"
                              value={r.method}
                              options={methods}
                              onChange={(v) => setRow(i, { method: v })}
                            />
                            {!isLast ? (
                              <s-button onClick={() => removeRow(i)} disabled={loading}>
                                この行を消す
                              </s-button>
                            ) : null}
                          </s-stack>
                        </s-box>
                      );
                    })
                  )}
                  {methods.length > 0 ? (
                    split ? (
                      <s-stack direction="inline" gap="small">
                        <s-button onClick={addRow} disabled={loading}>行を追加</s-button>
                        <s-button onClick={stopSplit} disabled={loading}>分割をやめる</s-button>
                      </s-stack>
                    ) : (
                      <s-button onClick={startSplit} disabled={loading}>分割</s-button>
                    )
                  ) : null}
                  <s-text-field
                    label="メモ（任意）"
                    value={note}
                    onInput={(e) => setNote(e?.currentTarget?.value ?? "")}
                    placeholder="補足説明など"
                  />
                  <s-button variant="primary" onClick={submit} disabled={loading || methods.length === 0}>
                    予約する
                  </s-button>
                  <s-text tone="neutral">予約はその日のうちの返金にだけ使います。返金した額が「返金する金額」と違うときは、自動では付け替えません。</s-text>
                </s-stack>
              </s-section>
            ) : null}

            {recent.length > 0 ? (
              <s-section heading="前の予約">
                <s-stack gap="small">
                  {recent.map((r) => (
                    <ReservationCard key={r.id} item={r} onCancel={cancel} loading={loading} />
                  ))}
                </s-stack>
              </s-section>
            ) : null}

            {onOtherRegistration ? (
              <s-section heading="ほかの登録">
                <s-stack gap="small">
                  <s-text tone="neutral">POS で返金せずに、ここで返金やレシートの現金の直しを登録するとき。</s-text>
                  <s-button onClick={onOtherRegistration} disabled={loading}>
                    ここで登録する
                  </s-button>
                </s-stack>
              </s-section>
            ) : null}
          </s-stack>
        </s-box>
      </s-scroll-box>
      <FixedFooterNavBar
        leftLabel="戻る"
        onLeft={onBack}
        rightLabel="再読込"
        onRight={() => {
          setError("");
          setNotice("");
          reload();
        }}
        rightDisabled={loading}
        centerAlignWithButtons
      />
    </s-page>
  );
}
