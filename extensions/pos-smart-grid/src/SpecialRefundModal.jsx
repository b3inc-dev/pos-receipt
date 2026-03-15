/**
 * 特殊返金・商品券調整モーダル
 * 要件書 §7, §23.2
 *
 * Steps:
 *   search      → 取引検索一覧
 *   order_view  → 取引選択後（イベント一覧 + アクション選択）
 *   form_refund → 特殊返金フォーム
 *   form_voucher→ 商品券調整フォーム
 *   confirm     → 確認画面
 *   success     → 完了
 */
import { render } from "preact";
import { useState, useCallback, useEffect } from "preact/hooks";
import { searchOrders, getOrder } from "../../common/orderPickerApi.js";
import {
  listSpecialRefunds,
  createSpecialRefund,
  createVoucherAdjustment,
  voidSpecialRefund,
} from "../../common/specialRefundApi.js";
import { toUserMessage } from "../../common/errorMessage.js";

const STORAGE_KEY = "pos_special_refund_order_id";

// 特殊返金の event_type 選択肢（voucher_change_adjustment は商品券調整フォームで別途扱う）
const REFUND_EVENT_TYPES = [
  { value: "cash_refund", label: "現金返金（他手段→現金）" },
  { value: "payment_method_override", label: "返金手段変更" },
  { value: "receipt_cash_adjustment", label: "レシート現金調整" },
];

// 支払手段選択肢
const PAYMENT_METHODS = [
  { value: "cash", label: "現金" },
  { value: "credit_card", label: "クレジットカード" },
  { value: "e_money", label: "電子マネー" },
  { value: "qr_code", label: "QRコード決済" },
  { value: "voucher", label: "商品券" },
  { value: "points", label: "ポイント" },
  { value: "other", label: "その他" },
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
  const [step, setStep] = useState("search");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 取引詳細画面から起動した場合
  useEffect(() => {
    const preId = sessionStorage.getItem(STORAGE_KEY);
    if (preId) {
      sessionStorage.removeItem(STORAGE_KEY);
      setLoading(true);
      getOrder(preId)
        .then((order) => {
          setSelectedOrder(order);
          setStep("order_view");
          return listSpecialRefunds(order.orderId ?? preId);
        })
        .then((res) => setEvents(res.items ?? []))
        .catch((e) => setError(toUserMessage(e?.message) || "取得に失敗しました"))
        .finally(() => setLoading(false));
    }
  }, []);

  const handleOrderSelect = useCallback(async (orderId) => {
    setLoading(true);
    setError("");
    try {
      const order = await getOrder(orderId);
      setSelectedOrder(order);
      const res = await listSpecialRefunds(order.orderId ?? orderId);
      setEvents(res.items ?? []);
      setStep("order_view");
    } catch (e) {
      setError(toUserMessage(e?.message) || "取得に失敗しました");
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

  if (step === "search") {
    return (
      <OrderSearchView
        loading={loading}
        error={error}
        setError={setError}
        setLoading={setLoading}
        onSelect={handleOrderSelect}
      />
    );
  }

  if (step === "order_view") {
    return (
      <OrderView
        order={selectedOrder}
        events={events}
        loading={loading}
        error={error}
        onBack={() => { setSelectedOrder(null); setEvents([]); setStep("search"); }}
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
        onBack={() => setStep("order_view")}
        onSuccess={async () => {
          await refreshEvents();
          setStep("order_view");
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
        onBack={() => setStep("order_view")}
        onSuccess={async () => {
          await refreshEvents();
          setStep("order_view");
        }}
      />
    );
  }

  return null;
}

// ──────────────────────────────────────────────
// 取引検索ビュー
// ──────────────────────────────────────────────
function OrderSearchView({ loading, error, setError, setLoading, onSelect }) {
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);

  const onSearch = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const res = await searchOrders({
        q: q.trim() || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: 20,
      });
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(toUserMessage(e?.message) || "検索に失敗しました");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [q, dateFrom, dateTo, setError, setLoading]);

  const onLoadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoading(true);
    try {
      const res = await searchOrders({
        q: q.trim() || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        cursor: nextCursor,
        limit: 20,
      });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [q, dateFrom, dateTo, nextCursor, setLoading]);

  return (
    <s-page heading="取引を選択">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text-field
              label="注文番号・顧客名"
              value={q}
              onInput={(e) => setQ(e?.currentTarget?.value ?? "")}
              placeholder="#1001 または 顧客名"
            />
            <s-text-field
              label="日付から (YYYY-MM-DD)"
              value={dateFrom}
              onInput={(e) => setDateFrom(e?.currentTarget?.value ?? "")}
            />
            <s-text-field
              label="日付まで (YYYY-MM-DD)"
              value={dateTo}
              onInput={(e) => setDateTo(e?.currentTarget?.value ?? "")}
            />
            <s-button kind="primary" onClick={onSearch} loading={loading}>
              検索
            </s-button>
            {error ? <s-text tone="critical">{error}</s-text> : null}
          </s-stack>
        </s-box>

        {items.length > 0 ? (
          <s-box padding="base">
            <s-text fontWeight="bold">検索結果 ({items.length}件)</s-text>
            <s-stack gap="small" paddingBlockStart="small">
              {items.map((order) => (
                <s-pressable key={order.orderId} onPress={() => onSelect(order.orderId)}>
                  <s-box
                    padding="small"
                    borderWidth="base"
                    borderRadius="base"
                    borderColor="subdued"
                  >
                    <s-stack gap="extraSmall">
                      <s-text fontWeight="bold">{order.orderName}</s-text>
                      <s-text tone="subdued">
                        {order.customerName || "顧客なし"} — ¥{Number(order.totalPrice).toLocaleString()}
                      </s-text>
                      <s-text tone="subdued" fontSize="small">
                        {order.createdAt ? order.createdAt.slice(0, 10) : ""}
                        {order.locationName ? ` | ${order.locationName}` : ""}
                      </s-text>
                    </s-stack>
                  </s-box>
                </s-pressable>
              ))}
            </s-stack>
            {nextCursor ? (
              <s-box paddingBlockStart="base">
                <s-button kind="secondary" onClick={onLoadMore} loading={loading}>
                  さらに読み込む
                </s-button>
              </s-box>
            ) : null}
          </s-box>
        ) : !loading && (q || dateFrom || dateTo) ? (
          <s-box padding="base">
            <s-text tone="subdued">該当する取引がありません。</s-text>
          </s-box>
        ) : null}
      </s-scroll-box>
    </s-page>
  );
}

// ──────────────────────────────────────────────
// 取引詳細 + イベント一覧ビュー
// ──────────────────────────────────────────────
function OrderView({ order, events, loading, error, onBack, onRefund, onVoucher, onVoid }) {
  const activeEvents = events.filter((e) => e.status === "active");
  const voidedEvents = events.filter((e) => e.status === "voided");

  return (
    <s-page heading="特殊返金・商品券調整">
      <s-scroll-box>
        {/* 取引情報 */}
        <s-box padding="base" borderBlockEndWidth="base" borderColor="subdued">
          <s-stack gap="extraSmall">
            <s-text fontWeight="bold">{order?.orderName ?? "-"}</s-text>
            <s-text tone="subdued">
              {order?.customer?.displayName || "顧客なし"} —
              ¥{Number(order?.totalPrice?.amount ?? 0).toLocaleString()}
            </s-text>
            {order?.location?.name ? (
              <s-text tone="subdued" fontSize="small">{order.location.name}</s-text>
            ) : null}
          </s-stack>
        </s-box>

        {error ? (
          <s-box padding="base">
            <s-text tone="critical">{error}</s-text>
          </s-box>
        ) : null}

        {/* アクションボタン */}
        <s-box padding="base">
          <s-stack gap="small">
            <s-button kind="primary" onClick={onRefund} disabled={loading}>
              特殊返金を登録
            </s-button>
            <s-button kind="secondary" onClick={onVoucher} disabled={loading}>
              商品券調整を登録
            </s-button>
          </s-stack>
        </s-box>

        {/* 登録済みイベント */}
        {activeEvents.length > 0 ? (
          <s-box padding="base">
            <s-text fontWeight="bold">登録済みイベント ({activeEvents.length}件)</s-text>
            <s-stack gap="small" paddingBlockStart="small">
              {activeEvents.map((ev) => (
                <EventCard key={ev.id} event={ev} onVoid={onVoid} loading={loading} />
              ))}
            </s-stack>
          </s-box>
        ) : (
          <s-box padding="base">
            <s-text tone="subdued">この取引のイベントはありません。</s-text>
          </s-box>
        )}

        {/* 無効化済み */}
        {voidedEvents.length > 0 ? (
          <s-box padding="base">
            <s-text tone="subdued" fontSize="small">
              無効化済み: {voidedEvents.length}件
            </s-text>
          </s-box>
        ) : null}

        {/* 戻るボタン */}
        <s-box padding="base">
          <s-button kind="plain" onClick={onBack}>← 取引検索に戻る</s-button>
        </s-box>
      </s-scroll-box>
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
            {event.originalPaymentMethod ? `元: ${paymentLabel(event.originalPaymentMethod)}` : ""}
            {event.actualRefundMethod ? ` → 返金: ${paymentLabel(event.actualRefundMethod)}` : ""}
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
  const [originalPaymentMethod, setOriginalPaymentMethod] = useState("credit_card");
  const [actualRefundMethod, setActualRefundMethod] = useState("cash");
  const [adjustKind, setAdjustKind] = useState("undo");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);

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
                      <Row label="元の手段" value={paymentLabel(originalPaymentMethod)} />
                      <Row label="返金手段" value={paymentLabel(actualRefundMethod)} />
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
    <s-page heading="特殊返金を登録">
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
                  {PAYMENT_METHODS.map((m) => (
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
                  {PAYMENT_METHODS.map((m) => (
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
              <s-text fontWeight="bold">商品券調整を登録します</s-text>
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
    <s-page heading="商品券調整を登録">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {/* 取引情報 */}
            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-text tone="subdued">対象取引: {order?.orderName ?? "-"}</s-text>
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

function paymentLabel(value) {
  return PAYMENT_METHODS.find((m) => m.value === value)?.label ?? value ?? "-";
}
