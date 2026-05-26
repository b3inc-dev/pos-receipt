/**
 * 特殊返金・商品券調整モーダル
 * 要件書 §7, §23.2
 *
 * Steps:
 *   day_list     → ロケーション・年月日＋その日の取引一覧（バッジ）
 *   order_detail → 取引サマリー＋イベント一覧＋固定フッターで特殊返金／商品券調整を選択
 *   form_refund  → 特殊返金フォーム
 *   form_voucher → 商品券調整フォーム
 *
 * 取引詳細のメニュー: 「特殊返金」→ order_detail / 「商品券調整」→ form_voucher へ直行
 */
import { render } from "preact";
import { useState, useCallback, useEffect } from "preact/hooks";
import { getOrder } from "../../common/orderPickerApi.js";
import {
  listSpecialRefunds,
  createSpecialRefund,
  createVoucherAdjustment,
  voidSpecialRefund,
} from "../../common/specialRefundApi.js";
import { toUserMessage } from "../../common/errorMessage.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";
import { OrderDayListScreen } from "./OrderDayListScreen.jsx";
import { OrderDetailSummary } from "./OrderDetailSummary.jsx";
import { listSelectablePaymentMethods } from "../../common/paymentMethodsApi.js";

const STORAGE_KEY_REFUND = "pos_special_refund_order_id";
const STORAGE_KEY_VOUCHER = "pos_voucher_adjustment_order_id";

function tryDismissModal() {
  const dm = globalThis?.shopify?.action?.dismissModal;
  if (typeof dm === "function") {
    try {
      dm();
      return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

// 特殊返金の event_type 選択肢（voucher_change_adjustment は商品券調整フォームで別途扱う）
const REFUND_EVENT_TYPES = [
  { value: "cash_refund", label: "現金返金（他手段→現金）" },
  { value: "payment_method_override", label: "返金手段変更" },
  { value: "receipt_cash_adjustment", label: "レシート現金調整" },
];

const FALLBACK_PAYMENT_METHODS = [
  { value: "cash", label: "現金" },
  { value: "manual", label: "手動決済" },
];

const ADJUST_KINDS = [
  { value: "undo", label: "取消（返金）" },
  { value: "extra", label: "追加徴収" },
];

// イベント種別の日本語ラベル
const EVENT_TYPE_LABELS = {
  cash_refund: "現金返金",
  payment_method_override: "返金手段変更",
  receipt_cash_adjustment: "レシート現金調整",
  voucher_change_adjustment: "商品券調整",
};

export default async () => {
  render(<SpecialRefundModal />, document.body);
};

function SpecialRefundModal() {
  const [step, setStep] = useState("day_list");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [bootstrapError, setBootstrapError] = useState("");
  const [fromOrderEntry, setFromOrderEntry] = useState(false);
  const [orderEntryLoading, setOrderEntryLoading] = useState(false);

  // 取引詳細: 「特殊返金」または「商品券調整」から起動
  useEffect(() => {
    const vid = sessionStorage.getItem(STORAGE_KEY_VOUCHER);
    const rid = sessionStorage.getItem(STORAGE_KEY_REFUND);
    const preId = vid || rid;
    if (!preId) return;
    if (vid) sessionStorage.removeItem(STORAGE_KEY_VOUCHER);
    else sessionStorage.removeItem(STORAGE_KEY_REFUND);
    const voucherShortcut = Boolean(vid);

    setOrderEntryLoading(true);
    setBootstrapError("");
    getOrder(preId)
      .then(async (order) => {
        setSelectedOrder(order);
        const res = await listSpecialRefunds(order.orderId ?? preId);
        setEvents(res.items ?? []);
        setFromOrderEntry(true);
        setStep(voucherShortcut ? "form_voucher" : "order_detail");
      })
      .catch((e) => setBootstrapError(toUserMessage(e?.message) || "取得に失敗しました"))
      .finally(() => setOrderEntryLoading(false));
  }, []);

  const handleOrderSelect = useCallback(async (orderId) => {
    setLoading(true);
    setError("");
    setBootstrapError("");
    try {
      const order = await getOrder(orderId);
      setSelectedOrder(order);
      const res = await listSpecialRefunds(order.orderId ?? orderId);
      setEvents(res.items ?? []);
      setFromOrderEntry(false);
      setStep("order_detail");
    } catch (e) {
      setBootstrapError(toUserMessage(e?.message) || "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleVoid = useCallback(async (id) => {
    if (!confirm("このイベントを無効化しますか？")) return;
    setLoading(true);
    setError("");
    try {
      await voidSpecialRefund(id);
      setEvents((prev) =>
        prev.map((e) => (e.id === id ? { ...e, status: "voided" } : e))
      );
    } catch (e) {
      setError(toUserMessage(e?.message) || "無効化に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshEvents = useCallback(async () => {
    if (!selectedOrder) return;
    try {
      const res = await listSpecialRefunds(selectedOrder.orderId);
      setEvents(res.items ?? []);
    } catch {
      // silent
    }
  }, [selectedOrder]);

  if (orderEntryLoading) {
    return (
      <s-page heading="返金・商品券">
        <s-box padding="base">
          <s-text tone="subdued">取引を開いています…</s-text>
        </s-box>
      </s-page>
    );
  }

  if (step === "day_list") {
    return (
      <OrderDayListScreen
        pageHeading="返金・商品券（取引を選択）"
        badgeMode="specialRefund"
        onSelectOrderId={handleOrderSelect}
        noticeError={bootstrapError}
        onDismissNotice={() => setBootstrapError("")}
      />
    );
  }

  if (step === "order_detail") {
    return (
      <OrderDetailView
        order={selectedOrder}
        events={events}
        loading={loading}
        error={error}
        fromOrderEntry={fromOrderEntry}
        onBack={() => {
          if (fromOrderEntry && tryDismissModal()) return;
          setSelectedOrder(null);
          setEvents([]);
          setFromOrderEntry(false);
          setError("");
          setStep("day_list");
        }}
        onRefund={() => setStep("form_refund")}
        onVoucher={() => setStep("form_voucher")}
        onVoid={handleVoid}
      />
    );
  }

  if (step === "form_refund") {
    return (
      <SpecialRefundForm
        order={selectedOrder}
        loading={loading}
        error={error}
        setLoading={setLoading}
        setError={setError}
        onBack={() => setStep("order_detail")}
        onSuccess={async () => {
          await refreshEvents();
          setStep("order_detail");
        }}
      />
    );
  }

  if (step === "form_voucher") {
    return (
      <VoucherAdjustmentForm
        order={selectedOrder}
        loading={loading}
        error={error}
        setLoading={setLoading}
        setError={setError}
        onBack={() => setStep("order_detail")}
        onSuccess={async () => {
          await refreshEvents();
          setStep("order_detail");
        }}
      />
    );
  }

  return null;
}

// ──────────────────────────────────────────────
// 取引詳細（スクロール）＋固定フッターで処理選択
// ──────────────────────────────────────────────
function OrderDetailView({
  order,
  events,
  loading,
  error,
  fromOrderEntry,
  onBack,
  onRefund,
  onVoucher,
  onVoid,
}) {
  const activeEvents = events.filter((e) => e.status === "active");
  const voidedEvents = events.filter((e) => e.status === "voided");

  return (
    <s-page heading="特殊返金調整・商品券釣銭調整">
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
          <s-stack gap="extraSmall">
            <s-text fontWeight="bold" size="small">{order?.orderName ?? "-"}</s-text>
            <s-text tone="subdued" size="small">
              {order?.customer?.displayName || "顧客なし"} —
              ¥{Number(order?.totalPrice?.amount ?? 0).toLocaleString()}
            </s-text>
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
              <OrderDetailSummary order={order} />

              <s-divider />

              <s-text fontWeight="bold" size="small">アプリイベント</s-text>
              {activeEvents.length > 0 ? (
                <s-stack gap="small">
                  {activeEvents.map((ev) => (
                    <EventCard key={ev.id} event={ev} onVoid={onVoid} loading={loading} />
                  ))}
                </s-stack>
              ) : (
                <s-text tone="subdued" size="small">登録済みのイベントはありません。</s-text>
              )}

              {voidedEvents.length > 0 ? (
                <s-text tone="subdued" fontSize="small">
                  無効化済み: {voidedEvents.length}件
                </s-text>
              ) : null}

              {error ? <s-text tone="critical">{error}</s-text> : null}
            </s-stack>
          </s-box>
        </s-scroll-box>

        <s-divider />

        <FixedFooterNavBar
          centerAlignWithButtons
          leftLabel={fromOrderEntry ? "閉じる" : "戻る"}
          onLeft={onBack}
          leftDisabled={loading}
          middleLabel="特殊返金調整"
          onMiddle={onRefund}
          middleDisabled={loading}
          rightLabel="商品券釣銭調整"
          onRight={onVoucher}
          rightDisabled={loading}
        />
      </s-stack>
    </s-page>
  );
}

function EventCard({ event, onVoid, loading }) {
  const label = EVENT_TYPE_LABELS[event.eventType] ?? event.eventType;
  return (
    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack gap="extraSmall">
        <s-stack direction="horizontal" align="space-between">
          <s-text fontWeight="bold">{label}</s-text>
          <s-text>¥{Number(event.amount).toLocaleString()}</s-text>
        </s-stack>

        {event.eventType === "voucher_change_adjustment" ? (
          <s-text tone="subdued" fontSize="small">
            額面: ¥{Number(event.voucherFaceValue ?? 0).toLocaleString()} /
            充当: ¥{Number(event.voucherAppliedAmount ?? 0).toLocaleString()} /
            釣銭: ¥{Number(event.voucherChangeAmount ?? 0).toLocaleString()}
          </s-text>
        ) : null}

            {event.originalPaymentMethod || event.actualRefundMethod ? (
          <s-text tone="subdued" fontSize="small">
            {event.originalPaymentMethod ? `元: ${event.originalPaymentMethod}` : ""}
            {event.actualRefundMethod ? ` → 返金: ${event.actualRefundMethod}` : ""}
          </s-text>
        ) : null}

        {event.note ? (
          <s-text tone="subdued" fontSize="small">メモ: {event.note}</s-text>
        ) : null}

        <s-stack direction="horizontal" align="space-between">
          <s-text tone="subdued" fontSize="small">
            {event.createdAt ? event.createdAt.slice(0, 16).replace("T", " ") : ""}
          </s-text>
          <s-button
            kind="plain"
            tone="critical"
            onClick={() => onVoid(event.id)}
            disabled={loading}
          >
            無効化
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

// ──────────────────────────────────────────────
// 特殊返金フォーム
// ──────────────────────────────────────────────
function SpecialRefundForm({ order, loading, error, setLoading, setError, onBack, onSuccess }) {
  const [eventType, setEventType] = useState("cash_refund");
  const [amount, setAmount] = useState("");
  const [paymentMethods, setPaymentMethods] = useState(FALLBACK_PAYMENT_METHODS);
  const [originalPaymentMethod, setOriginalPaymentMethod] = useState("cash");
  const [actualRefundMethod, setActualRefundMethod] = useState("cash");
  const [adjustKind, setAdjustKind] = useState("undo");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    listSelectablePaymentMethods({ sync: true })
      .then((res) => {
        const items = res.items ?? [];
        if (items.length > 0) {
          setPaymentMethods(items);
          setOriginalPaymentMethod(items[0].value);
          const cash = items.find((m) => m.category === "cash" || m.value === "cash");
          setActualRefundMethod(cash?.value ?? items[0].value);
        }
      })
      .catch(() => {
        setPaymentMethods(FALLBACK_PAYMENT_METHODS);
      });
  }, []);

  const showPaymentFields =
    eventType === "cash_refund" || eventType === "payment_method_override";
  const showAdjustKind = eventType === "receipt_cash_adjustment";

  const handleConfirm = () => {
    setError("");
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      setError("金額を正しく入力してください");
      return;
    }
    setConfirming(true);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    try {
      await createSpecialRefund({
        sourceOrderId: order.orderId,
        sourceOrderName: order.orderName,
        locationId: order.location?.id ?? "",
        eventType,
        amount: Number(amount),
        currency: order.totalPrice?.currencyCode ?? "JPY",
        originalPaymentMethod: showPaymentFields ? originalPaymentMethod : null,
        actualRefundMethod: showPaymentFields ? actualRefundMethod : null,
        adjustKind: showAdjustKind ? adjustKind : null,
        note: note.trim() || null,
      });
      setConfirming(false);
      await onSuccess();
    } catch (e) {
      setError(toUserMessage(e?.message) || "登録に失敗しました");
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  };

  if (confirming) {
    return (
      <s-page heading="登録確認">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-text fontWeight="bold">以下の内容で登録します</s-text>
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="取引" value={order?.orderName ?? "-"} />
                  <Row label="種別" value={REFUND_EVENT_TYPES.find((t) => t.value === eventType)?.label ?? eventType} />
                  <Row label="金額" value={`¥${Number(amount).toLocaleString()}`} />
                  {showPaymentFields ? (
                    <>
                      <Row label="元の手段" value={paymentLabel(originalPaymentMethod, paymentMethods)} />
                      <Row label="返金手段" value={paymentLabel(actualRefundMethod, paymentMethods)} />
                    </>
                  ) : null}
                  {showAdjustKind ? (
                    <Row label="調整種別" value={ADJUST_KINDS.find((k) => k.value === adjustKind)?.label ?? adjustKind} />
                  ) : null}
                  {note ? <Row label="メモ" value={note} /> : null}
                </s-stack>
              </s-box>
              {error ? <s-text tone="critical">{error}</s-text> : null}
              <s-stack gap="small">
                <s-button kind="primary" onClick={handleSubmit} loading={loading}>
                  登録する
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

  return (
    <s-page heading="特殊返金調整を登録">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {/* 取引情報 */}
            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-text tone="subdued">対象取引: {order?.orderName ?? "-"}</s-text>
            </s-box>

            {/* 種別選択 */}
            <s-select
              label="返金種別"
              value={eventType}
              onChange={(e) => setEventType(e?.currentTarget?.value ?? e?.currentValue?.value ?? eventType)}
            >
              {REFUND_EVENT_TYPES.map((t) => (
                <s-option key={t.value} value={t.value}>{t.label}</s-option>
              ))}
            </s-select>

            {/* 金額 */}
            <s-text-field
              label="金額（円）"
              value={amount}
              type="number"
              onInput={(e) => setAmount(e?.currentTarget?.value ?? "")}
              placeholder="例: 1000"
            />

            {/* 支払手段（cash_refund / payment_method_override） */}
            {showPaymentFields ? (
              <>
                <s-select
                  label="元の支払手段"
                  value={originalPaymentMethod}
                  onChange={(e) =>
                    setOriginalPaymentMethod(e?.currentTarget?.value ?? e?.currentValue?.value ?? originalPaymentMethod)
                  }
                >
                  {paymentMethods.map((m) => (
                    <s-option key={m.value} value={m.value}>{m.label}</s-option>
                  ))}
                </s-select>
                <s-select
                  label="実際の返金手段"
                  value={actualRefundMethod}
                  onChange={(e) =>
                    setActualRefundMethod(e?.currentTarget?.value ?? e?.currentValue?.value ?? actualRefundMethod)
                  }
                >
                  {paymentMethods.map((m) => (
                    <s-option key={m.value} value={m.value}>{m.label}</s-option>
                  ))}
                </s-select>
              </>
            ) : null}

            {/* 調整種別（receipt_cash_adjustment） */}
            {showAdjustKind ? (
              <s-select
                label="調整種別"
                value={adjustKind}
                onChange={(e) => setAdjustKind(e?.currentTarget?.value ?? e?.currentValue?.value ?? adjustKind)}
              >
                {ADJUST_KINDS.map((k) => (
                  <s-option key={k.value} value={k.value}>{k.label}</s-option>
                ))}
              </s-select>
            ) : null}

            {/* メモ */}
            <s-text-field
              label="メモ（任意）"
              value={note}
              onInput={(e) => setNote(e?.currentTarget?.value ?? "")}
              placeholder="補足説明など"
            />

            {error ? <s-text tone="critical">{error}</s-text> : null}

            <s-stack gap="small">
              <s-button kind="primary" onClick={handleConfirm} disabled={loading}>
                確認する
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

// ──────────────────────────────────────────────
// 商品券調整フォーム
// ──────────────────────────────────────────────
function VoucherAdjustmentForm({ order, loading, error, setLoading, setError, onBack, onSuccess }) {
  const [faceValue, setFaceValue] = useState("");
  const [appliedAmount, setAppliedAmount] = useState("");
  const [changeAmount, setChangeAmount] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);

  // 釣銭自動計算
  const calcChange = useCallback(() => {
    const face = Number(faceValue);
    const applied = Number(appliedAmount);
    if (!isNaN(face) && !isNaN(applied) && face > 0 && applied > 0) {
      setChangeAmount(String(Math.max(0, face - applied)));
    }
  }, [faceValue, appliedAmount]);

  const handleConfirm = () => {
    setError("");
    if (!faceValue || !appliedAmount || !changeAmount) {
      setError("商品券額面・充当額・釣銭額をすべて入力してください");
      return;
    }
    if (isNaN(Number(faceValue)) || isNaN(Number(appliedAmount)) || isNaN(Number(changeAmount))) {
      setError("金額に不正な値が含まれています");
      return;
    }
    setConfirming(true);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    try {
      await createVoucherAdjustment({
        sourceOrderId: order.orderId,
        sourceOrderName: order.orderName,
        locationId: order.location?.id ?? "",
        voucherFaceValue: Number(faceValue),
        voucherAppliedAmount: Number(appliedAmount),
        voucherChangeAmount: Number(changeAmount),
        currency: order.totalPrice?.currencyCode ?? "JPY",
        note: note.trim() || null,
      });
      setConfirming(false);
      await onSuccess();
    } catch (e) {
      setError(toUserMessage(e?.message) || "登録に失敗しました");
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  };

  if (confirming) {
    return (
      <s-page heading="登録確認">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-text fontWeight="bold">商品券釣銭調整を登録します</s-text>
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="取引" value={order?.orderName ?? "-"} />
                  <Row label="商品券額面" value={`¥${Number(faceValue).toLocaleString()}`} />
                  <Row label="売上充当額" value={`¥${Number(appliedAmount).toLocaleString()}`} />
                  <Row label="釣銭額" value={`¥${Number(changeAmount).toLocaleString()}`} />
                  {note ? <Row label="メモ" value={note} /> : null}
                </s-stack>
              </s-box>
              {error ? <s-text tone="critical">{error}</s-text> : null}
              <s-stack gap="small">
                <s-button kind="primary" onClick={handleSubmit} loading={loading}>
                  登録する
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

  return (
    <s-page heading="商品券釣銭調整を登録">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {/* 取引情報 */}
            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="extraSmall">
                <s-text tone="subdued">対象取引: {order?.orderName ?? "-"}</s-text>
                {order?.estimatedVoucherChange ? (
                  <s-text tone="subdued" fontSize="small">この取引は商品券釣有りの可能性があります</s-text>
                ) : null}
              </s-stack>
            </s-box>

            {/* 商品券額面 */}
            <s-text-field
              label="商品券額面（円）"
              value={faceValue}
              type="number"
              onInput={(e) => setFaceValue(e?.currentTarget?.value ?? "")}
              onBlur={calcChange}
              placeholder="例: 1000"
            />

            {/* 売上充当額 */}
            <s-text-field
              label="売上充当額（円）"
              value={appliedAmount}
              type="number"
              onInput={(e) => setAppliedAmount(e?.currentTarget?.value ?? "")}
              onBlur={calcChange}
              placeholder="例: 800"
            />

            {/* 釣銭額（自動計算） */}
            <s-text-field
              label="釣銭額（円）"
              value={changeAmount}
              type="number"
              onInput={(e) => setChangeAmount(e?.currentTarget?.value ?? "")}
              placeholder="額面 − 充当額（自動計算）"
            />

            {/* メモ */}
            <s-text-field
              label="メモ（任意）"
              value={note}
              onInput={(e) => setNote(e?.currentTarget?.value ?? "")}
              placeholder="補足説明など"
            />

            {error ? <s-text tone="critical">{error}</s-text> : null}

            <s-stack gap="small">
              <s-button kind="primary" onClick={handleConfirm} disabled={loading}>
                確認する
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

// ──────────────────────────────────────────────
// ヘルパー
// ──────────────────────────────────────────────
function Row({ label, value }) {
  return (
    <s-stack direction="horizontal" align="space-between">
      <s-text tone="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-stack>
  );
}

function paymentLabel(value, methods = FALLBACK_PAYMENT_METHODS) {
  return methods.find((m) => m.value === value)?.label ?? value ?? "-";
}
