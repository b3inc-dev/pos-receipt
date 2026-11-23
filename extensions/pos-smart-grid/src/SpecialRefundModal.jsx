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
import { PosChoiceField } from "./PosChoiceField.jsx";
import { useState, useCallback, useEffect } from "preact/hooks";
import { getOrder, createRedoDraft } from "../../common/orderPickerApi.js";
import {
  listSpecialRefunds,
  createSpecialRefund,
  createVoucherAdjustment,
  voidSpecialRefund,
  recheckLegacySpecialRefund,
} from "../../common/specialRefundApi.js";
import { toUserMessage } from "../../common/errorMessage.js";
import {
  buildShopifyRefundRecheckRequest,
  canRecheckLegacyShopifyRefund,
  canRecheckShopifyRefund,
} from "../../common/specialRefundRecheck.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";
import { OrderDayListScreen } from "./OrderDayListScreen.jsx";
import { OrderDetailSummary } from "./OrderDetailSummary.jsx";
import { listSelectablePaymentMethods } from "../../common/paymentMethodsApi.js";
import {
  paymentMethodsWithOrderGateway,
  primarySaleTransaction,
} from "../../common/paymentMethodFallback.js";

const STORAGE_KEY_REFUND = "pos_special_refund_order_id";

/**
 * 確かめの画面（s-modal）。ブラウザの confirm() は POS UI 拡張で使えるか確かめられていないので使わない。
 * 精算の「発行確認」と同じく、s-modal を常に置いておき、ボタンの command="--show" commandFor={id} で開く。
 */
const SPECIAL_REFUND_CONFIRM_MODAL_ID = "pos-receipt-special-refund-confirm";

function hideSpecialRefundConfirmModal() {
  try {
    const el = document.getElementById(SPECIAL_REFUND_CONFIRM_MODAL_ID);
    el?.hide?.();
    el?.hideOverlay?.();
  } catch (_) {
    /* ignore */
  }
}

const RECHECK_CONFIRM_MESSAGE =
  "この登録の Shopify 返金を確かめます。\n\nShopify に返金ができていれば、その結果を記録します。" +
  "まだできていなければ、この登録の返金を今実行します（同じ登録なので 2 回にはなりません）。";

const LEGACY_RECHECK_CONFIRM_MESSAGE =
  "この登録の Shopify 返金を確かめます。\n\nShopify の注文の返金を読み直して、この登録の返金があれば「返金済」と記録します。" +
  "この画面からは Shopify の返金を実行しません（お金は動きません）。";

function buildLegacyLinkConfirmMessage(candidate) {
  const amount = Number(candidate?.amount ?? 0).toLocaleString();
  const at = candidate?.createdAt ? String(candidate.createdAt).slice(0, 16).replace("T", " ") : "-";
  return (
    `Shopify の返金（¥${amount}・${at}）を、この登録の返金として記録します。\n\n` +
    "Shopify の返金は実行しません。この返金がこの登録のものかを、Shopify の管理画面で確かめてから進めてください。"
  );
}

const LEGACY_NO_REFUND_CONFIRM_MESSAGE =
  "「Shopify に返金はありません」として記録します。\n\n" +
  "このあと精算では、この登録の金額をアプリの記録（店で渡したお金）として数えます。" +
  "Shopify の管理画面でこの注文に、この登録の返金が無いことを確かめてから進めてください。\n\n" +
  "Shopify の返金は実行しません。";
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

function buildVoidConfirmMessage(event) {
  let msg =
    "このイベントを無効化しますか？\n\n精算・アプリの記録からは外れます。";
  if (event?.shopifyRefundStatus === "pending") {
    msg +=
      "\n\n【重要】この登録は Shopify 返金の結果が分かっていません。";
    msg += "無効化する前に、Shopify の管理画面でこの注文に返金があるかを確かめ、";
    msg += "まずこの登録の「Shopify 返金を確かめる」を使ってください。";
    msg +=
      "\n\nShopify に返金があるのに無効化して登録し直すと、記録のみの登録になり、Shopify の返金と二重に数えられます。";
    msg +=
      "\nShopify に返金が無いのに無効化だけすると、店で渡したお金が精算から消えます。";
    return msg;
  }
  if (event?.shopifyRefundStatus === "success") {
    msg +=
      "\n\n【重要】この登録では Shopify 上に返金が作成済みです。";
    msg += "無効化しても Shopify の返金は自動では取り消されません。";
    msg += "必要な場合は Shopify 管理画面で手動対応してください。";
    msg +=
      "\n\n訂正する場合は、正しい内容で再登録してください（再登録は記録のみになります）。";
  } else if (event?.shopifyRefundStatus === "failed") {
    msg +=
      "\n\nShopify 返金は失敗しています。無効化後、正しい内容で再登録できます。";
  } else {
    msg += "\n\n訂正する場合は、正しい内容で再登録してください。";
  }
  return msg;
}

function buildRedoDraftConfirmMessage(order) {
  const name = order?.orderName ?? "-";
  return [
    `取引 ${name} と同じ商品構成で、会計やり直し用の下書き注文を作成します。`,
    "",
    "・決済は自動では行いません",
    "・Shopify POS または管理画面の「下書き注文」から会計してください",
    "・元の注文の返金・キャンセルは取り消されません",
    "",
    "作成しますか？",
  ].join("\n");
}

function CorrectionModeBanner({ orderCorrectionContext }) {
  if (!orderCorrectionContext?.nextRegistrationRecordOnly) return null;
  return (
    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-text tone="info" fontSize="small">
        この取引には無効化済みの登録があります。次の登録は訂正のため記録のみ（Shopify 実返金なし）になります。
      </s-text>
    </s-box>
  );
}

function formatShopifyRefundNotice(res) {
  if (res?.correctionRegistration) {
    return {
      tone: "info",
      text: "訂正として登録しました（記録のみ。Shopify 返金は行っていません）",
    };
  }
  const st = res?.shopifyRefund?.status ?? res?.event?.shopifyRefundStatus;
  const err = res?.shopifyRefund?.error ?? res?.event?.shopifyRefundError;
  if (st === "success") {
    return { tone: "success", text: "登録完了。Shopify で返金を実行しました。" };
  }
  if (st === "failed") {
    return {
      tone: "warning",
      text: `登録は完了しましたが、Shopify 返金に失敗しました。${err ? `（${err}）` : ""}`,
    };
  }
  if (st === "skipped") {
    const isCorrection = String(err ?? "").includes("訂正登録");
    return {
      tone: "info",
      text: isCorrection
        ? "訂正として登録しました（記録のみ。Shopify 返金は行っていません）"
        : "登録完了（記録のみ。Shopify 返金は行っていません）",
    };
  }
  return { tone: "success", text: "登録しました。" };
}

function ShopifyRefundStatusLine({ status, error }) {
  if (!status || status === "none") return null;
  if (status === "pending") {
    return (
      <s-text tone="critical" fontSize="small">
        Shopify 返金の結果が分かっていません（この日の精算が止まります）{error ? `: ${error}` : ""}
      </s-text>
    );
  }
  if (status === "success") {
    return <s-text tone="success" fontSize="small">Shopify 返金済</s-text>;
  }
  if (status === "failed") {
    return (
      <s-text tone="critical" fontSize="small">
        Shopify 返金失敗{error ? `: ${error}` : ""}
      </s-text>
    );
  }
  if (status === "skipped") {
    return <s-text tone="subdued" fontSize="small">記録のみ（Shopify 返金なし）</s-text>;
  }
  return null;
}

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
  const [submitNotice, setSubmitNotice] = useState(null);
  const [orderCorrectionContext, setOrderCorrectionContext] = useState(null);

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
    setFromOrderEntry(true);
    getOrder(preId)
      .then(async (order) => {
        setSelectedOrder(order);
        const res = await listSpecialRefunds(order.orderId ?? preId);
        setEvents(res.items ?? []);
        setOrderCorrectionContext(res.orderCorrectionContext ?? null);
        // 取引詳細メニューからは一覧を挟まず、各処理のフォームへ直行
        setStep(voucherShortcut ? "form_voucher" : "form_refund");
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
      setOrderCorrectionContext(res.orderCorrectionContext ?? null);
      setFromOrderEntry(false);
      setStep("order_detail");
    } catch (e) {
      setBootstrapError(toUserMessage(e?.message) || "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshEvents = useCallback(async () => {
    if (!selectedOrder) return;
    try {
      const res = await listSpecialRefunds(selectedOrder.orderId);
      setEvents(res.items ?? []);
      setOrderCorrectionContext(res.orderCorrectionContext ?? null);
    } catch {
      // silent
    }
  }, [selectedOrder]);

  // 確かめの画面に出す内容（{ kind, eventId, refundId?, candidate? }）。開くボタンの onClick で入れる
  const [confirmAction, setConfirmAction] = useState(null);
  // 前からの登録で、店の人が選ぶ必要があるとき（{ eventId, reason, candidates }）
  const [legacyDecision, setLegacyDecision] = useState(null);

  const runVoid = useCallback(
    async (id) => {
      const ev = events.find((e) => e.id === id);
      setLoading(true);
      setError("");
      try {
        const res = await voidSpecialRefund(id);
        await refreshEvents();
        if (res.warning) {
          setSubmitNotice({
            tone: ev?.shopifyRefundStatus === "success" ? "warning" : "info",
            text: res.warning,
          });
        }
      } catch (e) {
        setError(toUserMessage(e?.message) || "無効化に失敗しました");
      } finally {
        setLoading(false);
      }
    },
    [events, refreshEvents],
  );

  // pending の登録を同じキーのまま確かめ直す（返金は 2 回にならない。specialRefundRecheck.js）
  const runRecheck = useCallback(
    async (id) => {
      const ev = events.find((e) => e.id === id);
      const req = buildShopifyRefundRecheckRequest(ev);
      if (!req) return;
      setLoading(true);
      setError("");
      try {
        const res = await createSpecialRefund(req);
        await refreshEvents();
        setSubmitNotice(formatShopifyRefundNotice(res));
      } catch (e) {
        await refreshEvents();
        setError(
          `${toUserMessage(e?.message) || "確かめられませんでした"}。時間をおいて、もう一度「Shopify 返金を確かめる」を押してください。`,
        );
      } finally {
        setLoading(false);
      }
    },
    [events, refreshEvents],
  );

  // 前からの登録（ID が pos_sr_ で始まらない）。サーバーは Shopify を読み直すだけで、返金は実行しない
  const runLegacyRecheck = useCallback(
    async (id, body = {}) => {
      setLoading(true);
      setError("");
      try {
        const res = await recheckLegacySpecialRefund(id, body);
        await refreshEvents();
        if (res?.resolved) {
          setLegacyDecision(null);
          const st = res?.shopifyRefund?.status;
          setSubmitNotice(
            st === "success"
              ? { tone: "success", text: "Shopify に返金がありました。「返金済」と記録しました。" }
              : st === "failed"
                ? {
                    tone: "info",
                    text: "「Shopify に返金はありません」と記録しました。精算ではアプリの記録として数えます。",
                  }
                : { tone: "info", text: "この登録はもう決まっています。" },
          );
          return;
        }
        setLegacyDecision({
          eventId: id,
          reason: res?.reason ?? "none_found",
          candidates: Array.isArray(res?.candidates) ? res.candidates : [],
        });
      } catch (e) {
        await refreshEvents();
        setError(
          `${toUserMessage(e?.message) || "確かめられませんでした"}。時間をおいて、もう一度「Shopify 返金を確かめる」を押してください。`,
        );
      } finally {
        setLoading(false);
      }
    },
    [refreshEvents],
  );

  const runRedoDraft = useCallback(async () => {
    if (!selectedOrder?.canRedoAsDraft) return;
    setLoading(true);
    setError("");
    try {
      const res = await createRedoDraft(selectedOrder.orderId);
      const draftName = res.draftOrder?.name ?? "";
      const count = res.draftOrder?.lineItemCount ?? 0;
      const skipped =
        res.skippedLineCount > 0
          ? `（${res.skippedLineCount}行は数量0のためスキップ）`
          : "";
      setSubmitNotice({
        tone: "success",
        text: `${res.message ?? "下書きを作成しました"} 下書き: ${draftName} / ${count}品目${skipped}`,
      });
    } catch (e) {
      setError(toUserMessage(e?.message) || "下書きの作成に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedOrder]);

  const confirmMessage = (() => {
    if (!confirmAction) return "";
    const ev = events.find((e) => e.id === confirmAction.eventId);
    switch (confirmAction.kind) {
      case "void":
        return buildVoidConfirmMessage(ev);
      case "recheck":
        return RECHECK_CONFIRM_MESSAGE;
      case "legacy_recheck":
        return LEGACY_RECHECK_CONFIRM_MESSAGE;
      case "legacy_link":
        return buildLegacyLinkConfirmMessage(confirmAction.candidate);
      case "legacy_no_refund":
        return LEGACY_NO_REFUND_CONFIRM_MESSAGE;
      case "redo_draft":
        return buildRedoDraftConfirmMessage(selectedOrder);
      default:
        return "";
    }
  })();

  const handleConfirmExecute = useCallback(async () => {
    const action = confirmAction;
    hideSpecialRefundConfirmModal();
    setConfirmAction(null);
    if (!action) return;
    if (action.kind === "void") await runVoid(action.eventId);
    else if (action.kind === "recheck") await runRecheck(action.eventId);
    else if (action.kind === "legacy_recheck") await runLegacyRecheck(action.eventId);
    else if (action.kind === "legacy_link") {
      await runLegacyRecheck(action.eventId, { resolution: "link", refundId: action.refundId });
    } else if (action.kind === "legacy_no_refund") {
      await runLegacyRecheck(action.eventId, { resolution: "no_refund" });
    } else if (action.kind === "redo_draft") await runRedoDraft();
  }, [confirmAction, runVoid, runRecheck, runLegacyRecheck, runRedoDraft]);

  if (orderEntryLoading) {
    return (
      <s-page heading="返金・商品券">
        <s-box padding="base">
          <s-text tone="subdued">取引を開いています…</s-text>
        </s-box>
      </s-page>
    );
  }

  if (bootstrapError && fromOrderEntry) {
    return (
      <s-page heading="返金・商品券">
        <s-box padding="base">
          <s-stack gap="base">
            <s-text tone="critical">{bootstrapError}</s-text>
            <s-text tone="subdued" size="small">
              取引詳細から開けませんでした。アプリの権限更新後に再度お試しください。
            </s-text>
            <s-button
              kind="primary"
              onClick={() => {
                if (tryDismissModal()) return;
                setBootstrapError("");
                setFromOrderEntry(false);
                setStep("day_list");
              }}
            >
              閉じる
            </s-button>
          </s-stack>
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
          setOrderCorrectionContext(null);
          setLegacyDecision(null);
          setFromOrderEntry(false);
          setError("");
          setStep("day_list");
        }}
        onRefund={() => setStep("form_refund")}
        onVoucher={() => setStep("form_voucher")}
        onAskConfirm={setConfirmAction}
        legacyDecision={legacyDecision}
        confirmMessage={confirmMessage}
        onConfirmExecute={handleConfirmExecute}
        onConfirmCancel={() => setConfirmAction(null)}
        submitNotice={submitNotice}
        onDismissNotice={() => setSubmitNotice(null)}
        orderCorrectionContext={orderCorrectionContext}
      />
    );
  }

  if (step === "form_refund") {
    return (
      <SpecialRefundForm
        order={selectedOrder}
        orderCorrectionContext={orderCorrectionContext}
        loading={loading}
        error={error}
        setLoading={setLoading}
        setError={setError}
        onBack={() => {
          if (fromOrderEntry && tryDismissModal()) return;
          setStep("order_detail");
        }}
        onSuccess={async (notice) => {
          if (notice) setSubmitNotice(notice);
          await refreshEvents();
          if (fromOrderEntry && tryDismissModal()) return;
          setStep("order_detail");
        }}
      />
    );
  }

  if (step === "form_voucher") {
    return (
      <VoucherAdjustmentForm
        order={selectedOrder}
        orderCorrectionContext={orderCorrectionContext}
        loading={loading}
        error={error}
        setLoading={setLoading}
        setError={setError}
        onBack={() => {
          if (fromOrderEntry && tryDismissModal()) return;
          setStep("order_detail");
        }}
        onSuccess={async () => {
          setSubmitNotice({
            tone: "info",
            text: "登録完了（商品券調整は記録のみ。Shopify 返金は行いません）",
          });
          await refreshEvents();
          if (fromOrderEntry && tryDismissModal()) return;
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
  onAskConfirm,
  legacyDecision,
  confirmMessage,
  onConfirmExecute,
  onConfirmCancel,
  submitNotice,
  onDismissNotice,
  orderCorrectionContext,
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

              {order?.canRedoAsDraft ? (
                <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack gap="small">
                    <s-text fontWeight="bold" size="small">会計をやり直す</s-text>
                    <s-text tone="subdued" fontSize="small">
                      キャンセル・返金済みの取引向けです。同じ商品構成の下書き注文を作成します。決済は POS または管理画面で行ってください。
                    </s-text>
                    <s-button
                      kind="secondary"
                      command="--show"
                      commandFor={SPECIAL_REFUND_CONFIRM_MODAL_ID}
                      onClick={() => onAskConfirm({ kind: "redo_draft" })}
                      disabled={loading}
                      loading={loading}
                    >
                      下書き注文を作成
                    </s-button>
                  </s-stack>
                </s-box>
              ) : null}

              <CorrectionModeBanner orderCorrectionContext={orderCorrectionContext} />

              {submitNotice ? (
                <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack gap="small">
                    <s-text tone={submitNotice.tone === "warning" ? "critical" : submitNotice.tone}>
                      {submitNotice.text}
                    </s-text>
                    {onDismissNotice ? (
                      <s-button kind="secondary" onClick={onDismissNotice}>
                        閉じる
                      </s-button>
                    ) : null}
                  </s-stack>
                </s-box>
              ) : null}

              <s-divider />

              <s-text fontWeight="bold" size="small">アプリイベント</s-text>
              {activeEvents.length > 0 ? (
                <s-stack gap="small">
                  {activeEvents.map((ev) => (
                    <EventCard
                      key={ev.id}
                      event={ev}
                      onAskConfirm={onAskConfirm}
                      legacyDecision={legacyDecision?.eventId === ev.id ? legacyDecision : null}
                      loading={loading}
                    />
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
      <SpecialRefundConfirmModal
        message={confirmMessage}
        loading={loading}
        onExecute={onConfirmExecute}
        onCancel={onConfirmCancel}
      />
    </s-page>
  );
}

function SpecialRefundConfirmModal({ message, loading, onExecute, onCancel }) {
  const lines = String(message ?? "").split("\n");
  return (
    <s-modal id={SPECIAL_REFUND_CONFIRM_MODAL_ID} heading="確かめ">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="small">
            {lines.map((line, i) =>
              line ? <s-text key={i}>{line}</s-text> : <s-box key={i} />,
            )}
          </s-stack>
        </s-box>
      </s-scroll-box>
      <s-button
        slot="secondary-actions"
        kind="secondary"
        command="--hide"
        commandFor={SPECIAL_REFUND_CONFIRM_MODAL_ID}
        onClick={onCancel}
        disabled={loading}
      >
        戻る
      </s-button>
      <s-button slot="primary-action" onClick={onExecute} disabled={loading || !message}>
        {loading ? "処理中…" : "続ける"}
      </s-button>
    </s-modal>
  );
}

function LegacyDecisionPanel({ event, decision, onAskConfirm, loading }) {
  const candidates = decision?.candidates ?? [];
  const hasLikely = candidates.some((c) => c.looksLikeThisEvent);
  return (
    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack gap="small">
        <s-text fontWeight="bold" fontSize="small">
          {decision?.reason === "none_found"
            ? "Shopify の注文に、この登録の返金は見つかりませんでした"
            : "Shopify の注文に、この登録かもしれない返金があります"}
        </s-text>
        <s-text tone="subdued" fontSize="small">
          Shopify の管理画面でこの注文の返金を確かめて、下から選んでください。どれを選んでも Shopify の返金は実行しません。
        </s-text>
        {candidates.map((c) => (
          <s-stack key={c.refundId} gap="extraSmall">
            <s-text fontSize="small">
              ¥{Number(c.amount ?? 0).toLocaleString()} ・
              {c.createdAt ? ` ${String(c.createdAt).slice(0, 16).replace("T", " ")}` : " -"}
              {c.looksLikeThisEvent ? "（特殊返金のメモ・金額が合う）" : ""}
            </s-text>
            {c.note ? <s-text tone="subdued" fontSize="small">メモ: {c.note}</s-text> : null}
            <s-button
              kind="secondary"
              command="--show"
              commandFor={SPECIAL_REFUND_CONFIRM_MODAL_ID}
              onClick={() =>
                onAskConfirm({
                  kind: "legacy_link",
                  eventId: event.id,
                  refundId: c.refundId,
                  candidate: c,
                })
              }
              disabled={loading}
            >
              この返金がこの登録のもの
            </s-button>
          </s-stack>
        ))}
        {hasLikely ? null : (
          <s-button
            kind="secondary"
            tone="critical"
            command="--show"
            commandFor={SPECIAL_REFUND_CONFIRM_MODAL_ID}
            onClick={() => onAskConfirm({ kind: "legacy_no_refund", eventId: event.id })}
            disabled={loading}
          >
            Shopify に返金はありません
          </s-button>
        )}
      </s-stack>
    </s-box>
  );
}

function EventCard({ event, onAskConfirm, legacyDecision, loading }) {
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

        <ShopifyRefundStatusLine
          status={event.shopifyRefundStatus}
          error={event.shopifyRefundError}
        />

        {canRecheckShopifyRefund(event) || canRecheckLegacyShopifyRefund(event) ? (
          <s-stack gap="extraSmall">
            <s-text tone="subdued" fontSize="small">
              先に Shopify の管理画面でこの注文に返金があるかを確かめてから押してください。登録し直さないでください。
            </s-text>
            <s-button
              kind="secondary"
              command="--show"
              commandFor={SPECIAL_REFUND_CONFIRM_MODAL_ID}
              onClick={() =>
                onAskConfirm({
                  kind: canRecheckShopifyRefund(event) ? "recheck" : "legacy_recheck",
                  eventId: event.id,
                })
              }
              disabled={loading}
            >
              Shopify 返金を確かめる
            </s-button>
          </s-stack>
        ) : null}

        {legacyDecision ? (
          <LegacyDecisionPanel
            event={event}
            decision={legacyDecision}
            onAskConfirm={onAskConfirm}
            loading={loading}
          />
        ) : null}

        <s-stack direction="horizontal" align="space-between">
          <s-text tone="subdued" fontSize="small">
            {event.createdAt ? event.createdAt.slice(0, 16).replace("T", " ") : ""}
          </s-text>
          <s-button
            kind="plain"
            tone="critical"
            command="--show"
            commandFor={SPECIAL_REFUND_CONFIRM_MODAL_ID}
            onClick={() => onAskConfirm({ kind: "void", eventId: event.id })}
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
function SpecialRefundForm({
  order,
  orderCorrectionContext,
  loading,
  error,
  setLoading,
  setError,
  onBack,
  onSuccess,
}) {
  const orderGateway = String(primarySaleTransaction(order)?.gateway ?? "").trim();
  const fallbackPaymentMethods = paymentMethodsWithOrderGateway(
    FALLBACK_PAYMENT_METHODS,
    order,
  );
  const [eventType, setEventType] = useState("cash_refund");
  const [amount, setAmount] = useState("");
  const [paymentMethods, setPaymentMethods] = useState(fallbackPaymentMethods);
  // 実際の返金手段は支払方法マスタ（特殊返金で選べるもの）からだけ選ぶ。注文の決済手段や既定の候補は足さない
  const [refundMethods, setRefundMethods] = useState([]);
  const [refundMethodsState, setRefundMethodsState] = useState("loading"); // loading | ready | empty | error
  const [originalPaymentMethod, setOriginalPaymentMethod] = useState(orderGateway || "cash");
  const [actualRefundMethod, setActualRefundMethod] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(null);
  const [adjustKind, setAdjustKind] = useState("undo");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    // 内容を変えた操作は別intent。同じキーを再利用するとpayload mismatchになる。
    setIdempotencyKey(null);
  }, [eventType, amount, originalPaymentMethod, actualRefundMethod, adjustKind, note]);

  useEffect(() => {
    listSelectablePaymentMethods({ sync: true })
      .then((res) => {
        const masterItems = res.items ?? [];
        setRefundMethods(masterItems);
        setRefundMethodsState(masterItems.length > 0 ? "ready" : "empty");
        const masterCash = masterItems.find((m) => m.category === "cash" || m.value === "cash");
        setActualRefundMethod(masterCash?.value ?? masterItems[0]?.value ?? "");
        const items = paymentMethodsWithOrderGateway(masterItems, order);
        if (items.length > 0) {
          setPaymentMethods(items);
          const normalizedOrderGateway = orderGateway.toLowerCase();
          const orderMethod = items.find((m) => {
            const value = String(m.value ?? "").toLowerCase();
            return (
              value === normalizedOrderGateway ||
              (normalizedOrderGateway && normalizedOrderGateway.includes(value)) ||
              (normalizedOrderGateway && value.includes(normalizedOrderGateway))
            );
          });
          setOriginalPaymentMethod(orderMethod?.value || orderGateway || items[0].value);
        }
      })
      .catch(() => {
        setPaymentMethods(fallbackPaymentMethods);
        setOriginalPaymentMethod(orderGateway || fallbackPaymentMethods[0].value);
        setRefundMethods([]);
        setRefundMethodsState("error");
        setActualRefundMethod("");
      });
  }, [order?.orderId]);

  const showPaymentFields =
    eventType === "cash_refund" || eventType === "payment_method_override";
  const showAdjustKind = eventType === "receipt_cash_adjustment";

  const handleConfirm = () => {
    setError("");
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      setError("金額を正しく入力してください");
      return;
    }
    if (showPaymentFields && !refundMethods.some((m) => m.value === actualRefundMethod)) {
      setError(refundMethodsMessage(refundMethodsState) || "実際の返金手段を選んでください");
      return;
    }
    if (!idempotencyKey) {
      const generated = globalThis?.crypto?.randomUUID?.() ??
        `pos-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      setIdempotencyKey(generated);
    }
    setConfirming(true);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await createSpecialRefund({
        idempotencyKey,
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
      setIdempotencyKey(null);
      setConfirming(false);
      await onSuccess(formatShopifyRefundNotice(res));
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
                      <Row label="返金手段" value={paymentLabel(actualRefundMethod, refundMethods)} />
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

            <CorrectionModeBanner orderCorrectionContext={orderCorrectionContext} />

            {/* 種別選択 */}
            <PosChoiceField
              label="返金種別"
              value={eventType}
              options={REFUND_EVENT_TYPES}
              onChange={setEventType}
            />

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
                <PosChoiceField
                  label="元の支払手段"
                  value={originalPaymentMethod}
                  options={paymentMethods}
                  onChange={setOriginalPaymentMethod}
                />
                {refundMethods.length > 0 ? (
                  <PosChoiceField
                    label="実際の返金手段"
                    value={actualRefundMethod}
                    options={refundMethods}
                    onChange={setActualRefundMethod}
                  />
                ) : (
                  <s-text tone={refundMethodsState === "loading" ? "subdued" : "critical"} fontSize="small">
                    {refundMethodsMessage(refundMethodsState)}
                  </s-text>
                )}
              </>
            ) : null}

            {/* 調整種別（receipt_cash_adjustment） */}
            {showAdjustKind ? (
              <PosChoiceField
                label="調整種別"
                value={adjustKind}
                options={ADJUST_KINDS}
                onChange={setAdjustKind}
              />
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
function VoucherAdjustmentForm({
  order,
  orderCorrectionContext,
  loading,
  error,
  setLoading,
  setError,
  onBack,
  onSuccess,
}) {
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

            <CorrectionModeBanner orderCorrectionContext={orderCorrectionContext} />

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

/** 実際の返金手段を選べないときの文（支払方法マスタからしか選べない） */
function refundMethodsMessage(state) {
  if (state === "loading") return "支払方法を読み込み中…";
  if (state === "error") return "支払方法を読み込めませんでした。通信を確かめて、この画面を開き直してください。";
  if (state === "empty") return "特殊返金で選べる支払方法がありません。管理画面の「支払方法」で登録してください。";
  return "";
}

function paymentLabel(value, methods = FALLBACK_PAYMENT_METHODS) {
  return methods.find((m) => m.value === value)?.label ?? value ?? "-";
}
