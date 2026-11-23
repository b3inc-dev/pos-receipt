/**
 * 返金方法変更・商品券釣銭登録モーダル
 * 要件書 §7, §23.2
 *
 * Steps:
 *   day_list     → ロケーション・年月日＋その日の取引一覧（バッジ）
 *   order_detail → 取引サマリー＋イベント一覧＋固定フッターで特殊返金／商品券釣銭登録を選択
 *   form_refund  → 特殊返金フォーム
 *   form_voucher → 商品券釣銭登録フォーム（額面だけ入れる。使った額は注文の取引から）
 *   form_edit    → 登録の「変更」（前の登録を無効にし、直した内容の登録を足す。Shopify の返金はしない）
 *
 * タイルごとに一覧の最初の絞り込みを変える: 「返金・商品券」タイルは返金・キャンセル、「商品券」タイルは商品券釣有り
 * （VoucherModal.jsx が initialListSegment="voucher_change" で開く）
 *
 * 取引詳細のメニュー: 「特殊返金」→ order_detail / 「商品券釣銭登録」→ form_voucher へ直行
 */
import { render } from "preact";
import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import { getOrder, createRedoDraft } from "../../common/orderPickerApi.js";
import { PosChoiceField } from "./PosChoiceField.jsx";
import { NativeRefundReassignForm } from "./NativeRefundReassignForm.jsx";
import { RefundReservationForm } from "./RefundReservationForm.jsx";
import {
  listSpecialRefunds,
  createSpecialRefund,
  createVoucherAdjustment,
  voidSpecialRefund,
  recheckLegacySpecialRefund,
  editSpecialRefund,
  getVoucherApplied,
  getRefundReservationEnabled,
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
import { adjustmentBadges, adjustmentKindLabel, adjustmentSubLines, financialStatusTone } from "../../common/orderDetailLayout.js";
import { financialStatusLabel } from "./orderDisplayUtils.js";
import { listSelectablePaymentMethods } from "../../common/paymentMethodsApi.js";
import {
  orderTenderLines,
  fullAmountForRefund,
  matchMethodValue,
  roundMoney,
  originalMethodChoices,
  defaultOriginalMethod,
} from "../../common/orderTenderLines.js";
import { REFUND_MODES, refundEventTypeFor } from "../../common/refundModes.js";
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
  "この調整の返金を確かめます。\n\nShopify に返金ができていれば、その結果を記録します。" +
  "まだできていなければ、この調整の返金を今実行します（同じ調整なので 2 回にはなりません）。";

const LEGACY_RECHECK_CONFIRM_MESSAGE =
  "この調整の返金を確かめます。\n\nShopify の注文の返金を読み直して、この調整の返金があれば「返金済」と記録します。" +
  "ここでは Shopify の返金を実行しません（お金は動きません）。";

/** 端末の時刻で「11/24 01:27」の形にする（UTC のまま出さない） */
function localDateTimeLabel(iso) {
  const d = new Date(String(iso ?? ""));
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildLegacyLinkConfirmMessage(candidate) {
  const amount = Number(candidate?.amount ?? 0).toLocaleString();
  return (
    `Shopify の返金（¥${amount}・${localDateTimeLabel(candidate?.createdAt)}）を、この調整の返金として記録します。\n\n` +
    "Shopify の返金は実行しません。この返金がこの調整のものかを、Shopify の管理画面で確かめてから進めてください。"
  );
}

const LEGACY_NO_REFUND_CONFIRM_MESSAGE =
  "この調整の返金は Shopify に無い、と記録します。\n\n" +
  "このあと精算では、この調整の金額をアプリの記録（店で渡したお金）として数えます。" +
  "Shopify の管理画面で、この注文にこの調整の返金が無いことを確かめてから進めてください。\n\n" +
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

// 特殊返金の event_type 選択肢（voucher_change_adjustment は商品券釣銭登録フォームで別途扱う）
const FALLBACK_PAYMENT_METHODS = [
  { value: "cash", label: "現金" },
  { value: "manual", label: "手動決済" },
];

const ADJUST_KINDS = [
  { value: "undo", label: "返金を取り消す（売上に戻す）" },
  { value: "extra", label: "現金を足す（売上に足す）" },
];

function buildVoidConfirmMessage(event) {
  let msg = "この調整を無効にしますか？\n\n精算からは外れます（履歴には残ります）。";
  if (event?.shopifyRefundStatus === "pending") {
    msg += "\n\n【重要】この調整は返金の結果がまだ分かっていません（返金処理中）。";
    msg += "無効にする前に、Shopify の管理画面でこの注文に返金があるかを確かめ、";
    msg += "まずこの調整の「返金を確かめる」を使ってください。";
    msg += "\n\nShopify に返金があるのに無効にして調整し直すと、記録だけの調整になり、Shopify の返金と二重に数えられます。";
    msg += "\nShopify に返金が無いのに無効にするだけだと、店で渡したお金が精算から消えます。";
    return msg;
  }
  if (event?.refundSource === "native") {
    msg += "\n\nこれは純正の返金の返金方法変更です。無効にすると、その返金は元の支払方法の返金に戻ります（純正の返金はそのまま）。";
  } else if (event?.shopifyRefundStatus === "success") {
    msg += "\n\n【重要】この調整では Shopify に返金をしています。";
    msg += "無効にしても Shopify の返金は取り消されません。";
    msg += "取り消すときは Shopify の管理画面でしてください。";
    msg += "\n\n直すときは、正しい内容で調整し直してください（調整し直すと記録だけになります）。";
  } else if (event?.shopifyRefundStatus === "failed") {
    msg += "\n\n返金は失敗しています（返金失敗）。無効にしたあと、正しい内容で調整し直せます。";
  } else {
    msg += "\n\n直すときは、正しい内容で調整し直してください。";
  }
  return msg;
}

/** 確認のタイトル（処理の名前）と、実行するボタンの文言 */
const CONFIRM_TITLES = {
  void: { heading: "無効化", action: "無効化する" },
  recheck: { heading: "返金を確かめる", action: "確かめる" },
  legacy_recheck: { heading: "返金を確かめる", action: "確かめる" },
  legacy_link: { heading: "返金をこの調整につなぐ", action: "つなぐ" },
  legacy_no_refund: { heading: "返金なしとして記録", action: "記録する" },
  redo_draft: { heading: "下書き注文を作成", action: "作成する" },
};

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
    <s-text type="small" tone="info">
      無効化した調整があるため、次の登録は記録のみ（返金はしません）です。
    </s-text>
  );
}

function formatShopifyRefundNotice(res) {
  const base = formatShopifyRefundNoticeBase(res);
  // 管理者の承認が要る店（設定でオン）の付け替え（返金手段変更・現金返金）は、承認されるまで精算に入らない
  if (res?.approvalRequired || res?.event?.approvalStatus === "pending") {
    return {
      tone: base.tone === "warning" ? "warning" : "info",
      text: `${base.text} 管理者の承認待ちです。承認されるまで精算に入りません。`,
    };
  }
  return base;
}

/** 「Shopify 返金を確かめる」の結果（返金を実行したのではなく、結果を確かめた） */
function formatRecheckNotice(res) {
  const st = res?.shopifyRefund?.status ?? res?.event?.shopifyRefundStatus;
  if (st === "success") {
    return { tone: "success", text: "返金を確かめました。返金済と記録しました。" };
  }
  if (st === "failed") {
    return {
      tone: "warning",
      text: "返金は失敗していました（返金失敗）。精算ではアプリの記録として数えます。",
    };
  }
  if (st === "pending") {
    return {
      tone: "warning",
      text: "返金の結果はまだ分かりません（返金処理中）。時間をおいて、もう一度「返金を確かめる」を押してください。",
    };
  }
  return { tone: "info", text: "返金を確かめました。" };
}

function formatShopifyRefundNoticeBase(res) {
  if (res?.correctionRegistration) {
    return {
      tone: "info",
      text: "訂正として登録しました（記録のみ。返金はしていません）",
    };
  }
  const st = res?.shopifyRefund?.status ?? res?.event?.shopifyRefundStatus;
  const err = res?.shopifyRefund?.error ?? res?.event?.shopifyRefundError;
  if (st === "success") {
    return { tone: "success", text: "登録しました。返金もしました（返金済）。" };
  }
  if (st === "failed") {
    return {
      tone: "warning",
      text: `登録しましたが、返金に失敗しました。${err ? `（${err}）` : ""}`,
    };
  }
  if (st === "skipped") {
    const isCorrection = String(err ?? "").includes("訂正登録");
    return {
      tone: "info",
      text: isCorrection
        ? "訂正として登録しました（記録のみ。返金はしていません）"
        : "登録しました（記録のみ。返金はしていません）",
    };
  }
  return { tone: "success", text: "登録しました。" };
}

export default async () => {
  render(<SpecialRefundModal initialListSegment="refunded" />, document.body);
};

/**
 * @param {{ initialListSegment?: "all" | "refunded" | "voucher_change" }} props
 */
export function SpecialRefundModal({ initialListSegment = "refunded" }) {
  const [step, setStep] = useState("day_list");
  // 「変更」する登録
  const [editingEvent, setEditingEvent] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [bootstrapError, setBootstrapError] = useState("");
  const [fromOrderEntry, setFromOrderEntry] = useState(false);
  const [orderEntryLoading, setOrderEntryLoading] = useState(false);
  const [submitNotice, setSubmitNotice] = useState(null);
  const [orderCorrectionContext, setOrderCorrectionContext] = useState(null);
  // 店の特殊返金設定で使える種別（サーバーの一覧の応答から。読めないときは null＝全部）
  const [allowedEventTypes, setAllowedEventTypes] = useState(null);
  // POS 純正の返金（付け替えの候補）。読めなかったときは null（前の入力の形にする）
  const [nativeRefunds, setNativeRefunds] = useState(null);
  // 純正で返金した注文で「レシートの現金を直す」を選んだとき
  const [refundFormOther, setRefundFormOther] = useState(false);
  // まだ純正で返金していない注文で「ここで登録する」を選んだとき（返金の予約の画面を飛ばす）
  const [reservationSkipped, setReservationSkipped] = useState(false);

  // 取引詳細: 「特殊返金」または「商品券釣銭登録」から起動
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
        setAllowedEventTypes(Array.isArray(res.allowedEventTypes) ? res.allowedEventTypes : null);
        setOrderCorrectionContext(res.orderCorrectionContext ?? null);
        setNativeRefunds(Array.isArray(res.nativeRefunds) ? res.nativeRefunds : null);
        // 取引詳細メニューからは一覧を挟まず、各処理のフォームへ直行
        setStep(voucherShortcut ? "form_voucher" : "form_refund");
      })
      .catch((e) => setBootstrapError(toUserMessage(e?.message) || "取得に失敗しました"))
      .finally(() => setOrderEntryLoading(false));
  }, []);

  // 「返金前登録」（返金の予約）: 一覧の右下のボタンから、まだ返金していない注文を選んで予約の画面へ（T 2026-11-24）
  const [reservationEnabled, setReservationEnabled] = useState(false);
  const [reserveMode, setReserveMode] = useState(false);
  const reserveModeRef = useRef(false);
  reserveModeRef.current = reserveMode;
  useEffect(() => {
    if (initialListSegment === "voucher_change") return;
    let alive = true;
    getRefundReservationEnabled()
      .then((res) => {
        if (alive) setReservationEnabled(res?.enabled === true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [initialListSegment]);

  const handleOrderSelect = useCallback(async (orderId) => {
    setLoading(true);
    setError("");
    setBootstrapError("");
    try {
      const order = await getOrder(orderId);
      setSelectedOrder(order);
      const res = await listSpecialRefunds(order.orderId ?? orderId);
      setEvents(res.items ?? []);
        setAllowedEventTypes(Array.isArray(res.allowedEventTypes) ? res.allowedEventTypes : null);
      setOrderCorrectionContext(res.orderCorrectionContext ?? null);
        setNativeRefunds(Array.isArray(res.nativeRefunds) ? res.nativeRefunds : null);
      setFromOrderEntry(false);
      // 「返金前登録」から選んだ注文は、注文の詳細を挟まずに予約の画面へ
      setStep(reserveModeRef.current ? "form_refund" : "order_detail");
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
        setAllowedEventTypes(Array.isArray(res.allowedEventTypes) ? res.allowedEventTypes : null);
      setOrderCorrectionContext(res.orderCorrectionContext ?? null);
        setNativeRefunds(Array.isArray(res.nativeRefunds) ? res.nativeRefunds : null);
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
        // 精算を確定した日の登録を無効にしたときは、精算の再確定を案内する（確定した数は自動では変わらない）
        const parts = [res.warning].filter(Boolean);
        if (res.settlementAlreadyConfirmed) {
          const days = (res.confirmedDates ?? []).map(shortDateLabel).join("・");
          parts.push(
            `${days ? `${days} の` : "その日の"}精算はもう確定しています。精算の画面でその日を開き「更新」を押し、「今の数で再確定する」を押してください。`,
          );
        }
        if (res.metafieldWritten === false) parts.push("注文への記録はまだ書けていません。あとで開き直すと書き直します。");
        if (parts.length > 0) {
          setSubmitNotice({
            tone:
              res.settlementAlreadyConfirmed || (ev?.shopifyRefundStatus === "success" && ev?.refundSource !== "native")
                ? "warning"
                : "info",
            text: parts.join(" "),
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
        setSubmitNotice(formatRecheckNotice(res));
      } catch (e) {
        await refreshEvents();
        setError(
          `${toUserMessage(e?.message) || "確かめられませんでした"}。時間をおいて、もう一度「返金を確かめる」を押してください。`,
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
          `${toUserMessage(e?.message) || "確かめられませんでした"}。時間をおいて、もう一度「返金を確かめる」を押してください。`,
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

  // 確認のタイトルとボタンは処理の名前にそろえる（T 2026-11-24「タイトルを処理名で統一」）
  const confirmTitle = CONFIRM_TITLES[confirmAction?.kind] ?? null;

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
        key={reserveMode ? "reserve" : "list"}
        pageHeading={reserveMode ? "返金前登録（取引を選択）" : "返金・商品券（取引を選択）"}
        badgeMode="specialRefund"
        onSelectOrderId={handleOrderSelect}
        noticeError={bootstrapError}
        onDismissNotice={() => setBootstrapError("")}
        initialSegment={reserveMode ? "all" : initialListSegment}
        onBack={reserveMode ? () => setReserveMode(false) : undefined}
        listAction={
          reservationEnabled && !reserveMode ? { label: "返金前登録", onClick: () => setReserveMode(true) } : null
        }
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
        onRefund={() => {
          setRefundFormOther(false);
          setReservationSkipped(false);
          setStep("form_refund");
        }}
        onVoucher={() => setStep("form_voucher")}
        onEdit={(ev) => {
          setEditingEvent(ev);
          setError("");
          setStep("form_edit");
        }}
        onAskConfirm={setConfirmAction}
        legacyDecision={legacyDecision}
        confirmMessage={confirmMessage}
        confirmTitle={confirmTitle}
        onConfirmExecute={handleConfirmExecute}
        onConfirmCancel={() => setConfirmAction(null)}
        submitNotice={submitNotice}
        onDismissNotice={() => setSubmitNotice(null)}
        orderCorrectionContext={orderCorrectionContext}
      />
    );
  }

  if (step === "form_refund" && !refundFormOther && Array.isArray(nativeRefunds) && nativeRefunds.length > 0) {
    // 純正で返金した注文: 返金を選び、金額はそのまま手段だけ付け替える（手で金額を入れる形は出さない。二重に数えないため）
    const receiptAllowed = !allowedEventTypes || allowedEventTypes.includes("receipt_cash_adjustment");
    return (
      <NativeRefundReassignForm
        order={selectedOrder}
        nativeRefunds={nativeRefunds}
        events={events}
        allowedEventTypes={allowedEventTypes}
        loading={loading}
        error={error}
        setLoading={setLoading}
        setError={setError}
        onBack={() => {
          if (fromOrderEntry && tryDismissModal()) return;
          setStep("order_detail");
        }}
        onOtherRegistration={receiptAllowed ? () => { setError(""); setRefundFormOther(true); } : null}
        onSuccess={async (notice) => {
          if (notice) setSubmitNotice(notice);
          await refreshEvents();
          if (fromOrderEntry && tryDismissModal()) return;
          setStep("order_detail");
        }}
      />
    );
  }

  // まだ純正で返金していない注文: 返金の手段を先に決める（予約）。純正で返金したら自動で付け替える
  const reservationAllowed =
    !allowedEventTypes || allowedEventTypes.includes("cash_refund") || allowedEventTypes.includes("payment_method_override");
  if (step === "form_refund" && !reservationSkipped && reservationAllowed && Array.isArray(nativeRefunds) && nativeRefunds.length === 0) {
    return (
      <RefundReservationForm
        order={selectedOrder}
        allowedEventTypes={allowedEventTypes}
        onBack={() => {
          if (fromOrderEntry && tryDismissModal()) return;
          // 「返金前登録」の一覧から来たときは一覧へ戻る
          setStep(reserveMode ? "day_list" : "order_detail");
        }}
        onOtherRegistration={() => {
          setError("");
          setReservationSkipped(true);
        }}
        onApplied={refreshEvents}
      />
    );
  }

  if (step === "form_refund") {
    // 純正で返金した注文から来たときは「レシートの現金を直す」だけ
    const formAllowedTypes =
      refundFormOther && Array.isArray(nativeRefunds) && nativeRefunds.length > 0
        ? ["receipt_cash_adjustment"]
        : allowedEventTypes;
    return (
      <SpecialRefundForm
        order={selectedOrder}
        orderCorrectionContext={orderCorrectionContext}
        noNativeRefund={!refundFormOther && Array.isArray(nativeRefunds) && nativeRefunds.length === 0}
        allowedEventTypes={formAllowedTypes}
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

  if (step === "form_edit" && editingEvent) {
    return (
      <AdjustmentEditForm
        order={selectedOrder}
        event={editingEvent}
        loading={loading}
        error={error}
        setLoading={setLoading}
        setError={setError}
        onBack={() => {
          setEditingEvent(null);
          setStep("order_detail");
        }}
        onSuccess={async (notice) => {
          setEditingEvent(null);
          if (notice) setSubmitNotice(notice);
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
        orderCorrectionContext={orderCorrectionContext}
        loading={loading}
        error={error}
        setLoading={setLoading}
        setError={setError}
        onBack={() => {
          if (fromOrderEntry && tryDismissModal()) return;
          setStep("order_detail");
        }}
        onSuccess={async (res) => {
          const parts = ["登録しました（商品券釣銭登録は記録だけで、返金はしません）。"];
          if (res?.event?.countDate) parts.push(`注文の日（${shortDateLabel(res.event.countDate)}）の精算に入ります。`);
          if (res?.settlementAlreadyConfirmed) {
            parts.push("その日の精算はもう確定しています。精算の画面でその日を開き「更新」を押し、「今の数で再確定する」を押してください。");
          }
          if (res?.metafieldWritten === false) parts.push("注文への記録はまだ書けていません。あとで開き直すと書き直します。");
          setSubmitNotice({
            tone: res?.settlementAlreadyConfirmed ? "warning" : "info",
            text: parts.join(" "),
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
  onEdit,
  onAskConfirm,
  legacyDecision,
  confirmMessage,
  confirmTitle,
  onConfirmExecute,
  onConfirmCancel,
  submitNotice,
  onDismissNotice,
  orderCorrectionContext,
}) {
  const activeEvents = events.filter((e) => e.status === "active");
  const voidedEvents = events.filter((e) => e.status === "voided");
  // 商品券釣銭調整は「商品券釣有り」の注文だけ（一覧の「商品券釣有り」の印と同じ判定: 支払方法マスタの
  // 釣り有りの商品券で払った、またはメモに「商品券」）。支払いが 1 件も読めない注文は判定できないので押せるまま。
  const voucherAdjustable =
    Boolean(order?.estimatedVoucherChange) || (order?.transactions ?? []).length === 0;

  return (
    <s-page heading="特殊返金調整・商品券釣銭登録">
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
          {/* 注文番号と状態の印。右に日時（日本時間） */}
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-stack direction="inline" alignItems="center" gap="small">
              <s-text type="strong">{order?.orderName ?? "-"}</s-text>
              {order?.financialStatus || order?.cancelledAt ? (
                <s-badge tone={financialStatusTone(order?.financialStatus, order?.cancelledAt)}>
                  {financialStatusLabel(order?.financialStatus, order?.cancelledAt)}
                </s-badge>
              ) : null}
            </s-stack>
            <s-text type="small" color="subdued">
              {order?.transactionDateTime || order?.transactionTime || ""}
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
              <OrderDetailSummary order={order} events={activeEvents} />



              {/* 調整履歴（案A: 灰色の小さい見出し、1 件は一覧の行と同じ形） */}
              <s-stack gap="small-300">
                <s-text type="small" color="subdued">
                  {activeEvents.length > 0 ? `調整履歴（${activeEvents.length}件）` : "調整履歴"}
                </s-text>
                <CorrectionModeBanner orderCorrectionContext={orderCorrectionContext} />
                {/* 登録・変更・無効化の結果は、変わった所（調整履歴）の頭に出す（#104 の「会計をやり直す」と同じ考え） */}
                {submitNotice ? (
                  <s-box paddingBlock="small-300">
                    <s-stack gap="small-300">
                      <s-text type="strong" tone={submitNotice.tone === "warning" ? "critical" : submitNotice.tone}>
                        {submitNotice.text}
                      </s-text>
                      {onDismissNotice ? (
                        <s-stack direction="inline" gap="small">
                          <s-button variant="secondary" onClick={onDismissNotice}>
                            閉じる
                          </s-button>
                        </s-stack>
                      ) : null}
                    </s-stack>
                  </s-box>
                ) : null}
              </s-stack>
              {activeEvents.length > 0 ? (
                <s-stack gap="small">
                  {activeEvents.map((ev) => (
                    <EventCard
                      key={ev.id}
                      event={ev}
                      onEdit={onEdit}
                      onAskConfirm={onAskConfirm}
                      legacyDecision={legacyDecision?.eventId === ev.id ? legacyDecision : null}
                      loading={loading}
                    />
                  ))}
                </s-stack>
              ) : (
                <s-text type="small" color="subdued">まだ調整はありません。</s-text>
              )}

              {voidedEvents.length > 0 ? (
                <s-text type="small" color="subdued">
                  無効化した調整 {voidedEvents.length}件
                </s-text>
              ) : null}

              {/* 会計をやり直す（下書き注文を作成）は一番下（T 2026-11-23） */}
              {order?.canRedoAsDraft ? (
                <s-box paddingBlockStart="base">
                  <s-stack gap="small-300">
                    <s-text type="small" color="subdued">会計をやり直す</s-text>
                    <s-text type="small" color="subdued">
                      キャンセル・返金済みの注文と同じ商品で下書き注文を作ります。お会計は POS か管理画面でします。
                    </s-text>
                    <s-box paddingBlockStart="small-300">
                      <s-stack direction="inline" gap="small">
                        <s-button
                          variant="secondary"
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
                  </s-stack>
                </s-box>
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
          rightLabel="商品券釣銭登録"
          onRight={onVoucher}
          rightDisabled={loading || !voucherAdjustable}
        />
      </s-stack>
      <SpecialRefundConfirmModal
        title={confirmTitle}
        message={confirmMessage}
        loading={loading}
        onExecute={onConfirmExecute}
        onCancel={onConfirmCancel}
      />
    </s-page>
  );
}

function SpecialRefundConfirmModal({ title, message, loading, onExecute, onCancel }) {
  const lines = String(message ?? "").split("\n");
  return (
    <s-modal id={SPECIAL_REFUND_CONFIRM_MODAL_ID} heading={title?.heading || "確認"}>
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
        やめる
      </s-button>
      <s-button slot="primary-action" onClick={onExecute} disabled={loading || !message}>
        {loading ? "処理中…" : title?.action || "実行する"}
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
            ? "Shopify の注文に、この調整の返金は見つかりませんでした"
            : "Shopify の注文に、この調整かもしれない返金があります"}
        </s-text>
        <s-text tone="subdued" fontSize="small">
          Shopify の管理画面でこの注文の返金を確かめて、下から選んでください。どれを選んでも Shopify の返金は実行しません。
        </s-text>
        {candidates.map((c) => (
          <s-stack key={c.refundId} gap="extraSmall">
            <s-text fontSize="small">
              ¥{Number(c.amount ?? 0).toLocaleString()} ・
              {` ${localDateTimeLabel(c.createdAt)}`}
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
              この返金がこの調整のもの
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

/** 印だけでは足りない状態の説明（返金処理中・失敗の理由、承認待ち・却下の意味） */
function AdjustmentStatusNote({ event }) {
  const notes = [];
  if (event.shopifyRefundStatus === "pending") {
    notes.push(`結果待ちのため、この日の精算が止まっています${event.shopifyRefundError ? `（${event.shopifyRefundError}）` : ""}`);
  } else if (event.shopifyRefundStatus === "failed" && event.shopifyRefundError) {
    notes.push(`返金できなかった理由: ${event.shopifyRefundError}`);
  }
  if (event.approvalStatus === "pending") notes.push("管理者が承認するまで精算に入りません");
  if (event.approvalStatus === "rejected") notes.push("管理者が却下したため精算に入りません");
  if (notes.length === 0) return null;
  return (
    <s-stack gap="none">
      {notes.map((n, i) => (
        <s-text key={i} type="small" tone="critical">{n}</s-text>
      ))}
    </s-stack>
  );
}

function EventCard({ event, onEdit, onAskConfirm, legacyDecision, loading }) {
  const label = adjustmentKindLabel(event);
  // 案A（T 2026-11-23）: 一覧の行と同じ形。種類と金額は太字、手段・日時は灰色の小さい字、状態は色の印
  const badges = adjustmentBadges(event);
  return (
    <s-box paddingBlock="small-300">
      <s-stack gap="small-300">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack direction="inline" alignItems="center" gap="small">
            <s-text type="strong">{label}</s-text>
            {badges.map((bd) => (
              <s-badge key={bd.key} tone={bd.tone}>{bd.label}</s-badge>
            ))}
          </s-stack>
          <s-text type="strong">¥{Number(event.amount).toLocaleString("ja-JP")}</s-text>
        </s-stack>

        {adjustmentSubLines(event).map((line, i) => (
          <s-text key={i} type="small" color="subdued">{line}</s-text>
        ))}

        <AdjustmentStatusNote event={event} />

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
              返金を確かめる
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

        {/* ボタンは右に小さく。赤は「無効化」だけ */}
        <s-stack direction="inline" justifyContent="end" alignItems="center" gap="small">
          {canEditEvent(event) ? (
            <s-button variant="secondary" onClick={() => onEdit?.(event)} disabled={loading}>
              変更
            </s-button>
          ) : null}
          <s-button
            tone="critical"
            command="--show"
            commandFor={SPECIAL_REFUND_CONFIRM_MODAL_ID}
            onClick={() => onAskConfirm({ kind: "void", eventId: event.id })}
            disabled={loading}
          >
            無効化
          </s-button>
        </s-stack>
        {event.metafieldWritten === false ? (
          <s-text type="small" tone="critical">
            注文への記録がまだ書けていません。この画面を開き直すか、もう一度「変更」してください。
          </s-text>
        ) : null}
      </s-stack>
    </s-box>
  );
}

// ──────────────────────────────────────────────
// 特殊返金フォーム
// ──────────────────────────────────────────────
/** 元の支払い（支払方法ごとの支払った額・返金した額）と、1 行ずつの「全額反映」 */
function OrderTenderPanel({ order, lines, onFill, fillLabel = "全額反映", disabled }) {
  const total = roundMoney(order?.totalPrice?.amount ?? 0);
  return (
    <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack gap="small">
        <s-text tone="subdued">対象取引: {order?.orderName ?? "-"}（合計 ¥{total.toLocaleString()}）</s-text>
        {lines.length === 0 ? (
          <s-text tone="subdued" fontSize="small">注文の支払いを読めませんでした。金額は手で入れてください。</s-text>
        ) : (
          lines.map((line) => (
            <s-stack
              key={line.gateway || line.label}
              direction="inline"
              justifyContent="space-between"
              alignItems="center"
              gap="small"
            >
              <s-stack gap="none">
                <s-text fontWeight="bold">{line.label}</s-text>
                <s-text tone="subdued" fontSize="small">
                  {`支払い ¥${line.paid.toLocaleString()}`}
                  {line.refunded > 0 ? ` ／ 返金 ¥${line.refunded.toLocaleString()}` : ""}
                </s-text>
              </s-stack>
              {onFill ? (
                <s-button kind="secondary" onClick={() => onFill(line)} disabled={disabled}>
                  {fillLabel}
                </s-button>
              ) : null}
            </s-stack>
          ))
        )}
      </s-stack>
    </s-box>
  );
}

function SpecialRefundForm({
  order,
  orderCorrectionContext,
  noNativeRefund = false,
  allowedEventTypes = null,
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
  const tenderLines = orderTenderLines(order);
  // 元の支払手段は、この注文で実際に払われた支払方法だけ（1 つなら固定、複数ならその中から選ぶ）。
  // 注文の支払いを読めなかったときだけ、前のとおりマスタの候補から選ぶ
  const orderMethodChoices = originalMethodChoices(tenderLines);
  const originalFromOrder = orderMethodChoices.length > 0;
  const [mode, setMode] = useState("method");
  const [amount, setAmount] = useState("");
  const [paymentMethods, setPaymentMethods] = useState(originalFromOrder ? orderMethodChoices : fallbackPaymentMethods);
  // 実際の返金手段は支払方法マスタ（特殊返金で選べるもの）からだけ選ぶ。注文の決済手段や既定の候補は足さない
  const [refundMethods, setRefundMethods] = useState([]);
  const [refundMethodsState, setRefundMethodsState] = useState("loading"); // loading | ready | empty | error
  const [originalPaymentMethod, setOriginalPaymentMethod] = useState(
    (originalFromOrder ? defaultOriginalMethod(tenderLines) : null) || orderGateway || "cash",
  );
  const [actualRefundMethod, setActualRefundMethod] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(null);
  const [adjustKind, setAdjustKind] = useState("undo");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);

  // 全額反映: その支払方法の返金した額（無ければ支払った額）を金額に入れ、元の支払手段もその方法にする
  const fillFromTender = (line) => {
    setAmount(String(fullAmountForRefund(line)));
    const value = matchMethodValue(paymentMethods, line.gateway);
    if (value) setOriginalPaymentMethod(value);
  };

  useEffect(() => {
    // 内容を変えた操作は別intent。同じキーを再利用するとpayload mismatchになる。
    setIdempotencyKey(null);
  }, [mode, amount, originalPaymentMethod, actualRefundMethod, adjustKind, note]);

  useEffect(() => {
    listSelectablePaymentMethods({ sync: true })
      .then((res) => {
        const masterItems = res.items ?? [];
        setRefundMethods(masterItems);
        setRefundMethodsState(masterItems.length > 0 ? "ready" : "empty");
        const masterCash = masterItems.find((m) => m.category === "cash" || m.value === "cash");
        setActualRefundMethod(masterCash?.value ?? masterItems[0]?.value ?? "");
        const items = paymentMethodsWithOrderGateway(masterItems, order);
        // 注文の支払いから決めたときは、元の支払手段の候補をマスタで置き換えない
        if (!originalFromOrder && items.length > 0) {
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
        if (!originalFromOrder) {
          setPaymentMethods(fallbackPaymentMethods);
          setOriginalPaymentMethod(orderGateway || fallbackPaymentMethods[0].value);
        }
        setRefundMethods([]);
        setRefundMethodsState("error");
        setActualRefundMethod("");
      });
  }, [order?.orderId]);

  const methodAllowed =
    !allowedEventTypes || allowedEventTypes.includes("cash_refund") || allowedEventTypes.includes("payment_method_override");
  const receiptAllowed = !allowedEventTypes || allowedEventTypes.includes("receipt_cash_adjustment");
  const modes = REFUND_MODES.filter((m) => (m.value === "method" ? methodAllowed : receiptAllowed));
  const currentMode = modes.some((m) => m.value === mode) ? mode : modes[0]?.value ?? "method";
  const eventType = refundEventTypeFor(currentMode, actualRefundMethod, refundMethods, allowedEventTypes);
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
      setError(refundMethodsMessage(refundMethodsState) || "返金方法を選んでください");
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
      <s-page heading={currentMode === "receipt" ? "レシートの現金を直す" : "返金方法変更を登録"}>
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-text type="strong">この内容で登録します</s-text>
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="取引" value={order?.orderName ?? "-"} />
                  <Row label="内容" value={REFUND_MODES.find((m) => m.value === currentMode)?.label ?? ""} />
                  <Row label="金額" value={`¥${Number(amount).toLocaleString()}`} />
                  {showPaymentFields ? (
                    <>
                      <Row label="元の支払方法" value={paymentLabel(originalPaymentMethod, paymentMethods)} />
                      <Row label="返金方法" value={paymentLabel(actualRefundMethod, refundMethods)} />
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
            {/* 取引情報と元の支払い（支払方法ごと）。「全額反映」で金額と元の支払手段を入れる */}
            <OrderTenderPanel order={order} lines={tenderLines} onFill={fillFromTender} disabled={loading} />

            <CorrectionModeBanner orderCorrectionContext={orderCorrectionContext} />

            {/* 純正の返金の付け替えが出ない理由（POS で返金した記録が無い注文） */}
            {noNativeRefund ? (
              <s-text type="small" color="subdued">
                この注文には POS で返金した記録がありません。POS で返品・返金した注文では、返金額のまま返金方法だけを変更する画面になります。
              </s-text>
            ) : null}

            {/* 何をするか（2 つ）。種別は返金手段から決める */}
            {modes.length > 1 ? (
              <PosChoiceField
                label="何をしますか"
                value={currentMode}
                options={modes.map((m) => ({ value: m.value, label: m.label }))}
                onChange={setMode}
              />
            ) : (
              <s-text fontWeight="bold">{modes[0]?.label ?? ""}</s-text>
            )}
            <s-text tone="subdued" fontSize="small">{modes.find((m) => m.value === currentMode)?.help ?? ""}</s-text>

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
                {originalFromOrder && paymentMethods.length === 1 ? (
                  <s-stack gap="none">
                    <s-text tone="subdued" fontSize="small">元の支払方法（この注文の支払い）</s-text>
                    <s-text fontWeight="bold">{paymentMethods[0].label}</s-text>
                  </s-stack>
                ) : (
                  <PosChoiceField
                    label={originalFromOrder ? "元の支払方法（この注文で払われたものから選ぶ）" : "元の支払方法"}
                    value={originalPaymentMethod}
                    options={paymentMethods}
                    onChange={setOriginalPaymentMethod}
                  />
                )}
                {refundMethods.length > 0 ? (
                  <PosChoiceField
                    label="返金方法"
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
// 商品券釣銭登録フォーム
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
  // 使った額は注文の取引から入れる。読めないときだけ手で入れる
  const [appliedAmount, setAppliedAmount] = useState("");
  const [appliedState, setAppliedState] = useState("loading"); // loading | order | manual
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const tenderLines = orderTenderLines(order);

  useEffect(() => {
    if (!order?.orderId) return;
    setAppliedState("loading");
    getVoucherApplied(order.orderId)
      .then((res) => {
        if (res?.voucherAppliedAmount != null) {
          setAppliedAmount(String(res.voucherAppliedAmount));
          setAppliedState("order");
        } else {
          setAppliedState("manual");
        }
      })
      .catch(() => setAppliedState("manual"));
  }, [order?.orderId]);

  const face = Number(faceValue);
  const applied = Number(appliedAmount);
  const changeAmount =
    faceValue !== "" && appliedAmount !== "" && !isNaN(face) && !isNaN(applied)
      ? Math.max(0, face - applied)
      : null;

  const handleConfirm = () => {
    setError("");
    if (!faceValue || isNaN(face) || face <= 0) {
      setError("受け取った商品券の額面を入れてください");
      return;
    }
    if (appliedState === "loading") {
      setError("注文の商品券の支払いを読み込み中です。少し待ってからもう一度押してください");
      return;
    }
    if (appliedAmount === "" || isNaN(applied) || applied < 0) {
      setError("商品券で払った額を入れてください");
      return;
    }
    setConfirming(true);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await createVoucherAdjustment({
        sourceOrderId: order.orderId,
        sourceOrderName: order.orderName,
        locationId: order.location?.id ?? "",
        voucherFaceValue: face,
        // 注文から読めた額はサーバーでも読み直す（送らない）。手で入れたときだけ送る
        ...(appliedState === "manual" ? { voucherAppliedAmount: applied } : {}),
        currency: order.totalPrice?.currencyCode ?? "JPY",
        note: note.trim() || null,
      });
      setConfirming(false);
      await onSuccess(res);
    } catch (e) {
      setError(toUserMessage(e?.message) || "登録に失敗しました");
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  };

  if (confirming) {
    return (
      <s-page heading="商品券釣銭を登録">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-text type="strong">この内容で登録します</s-text>
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="取引" value={order?.orderName ?? "-"} />
                  <Row label="商品券額面" value={`¥${face.toLocaleString()}`} />
                  <Row label="商品券で払った額" value={`¥${applied.toLocaleString()}`} />
                  <Row label="お釣り" value={`¥${Number(changeAmount ?? 0).toLocaleString()}`} />
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
    <s-page heading="商品券釣銭を登録">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {/* 取引情報と元の支払い（支払方法ごと） */}
            <OrderTenderPanel order={order} lines={tenderLines} />
            {order?.estimatedVoucherChange ? (
              <s-text tone="subdued" fontSize="small">この取引は商品券釣有りの可能性があります</s-text>
            ) : null}

            <CorrectionModeBanner orderCorrectionContext={orderCorrectionContext} />

            {/* 商品券額面（入れるのはこれだけ） */}
            <s-text-field
              label="受け取った商品券の額面（円）"
              value={faceValue}
              type="number"
              onInput={(e) => setFaceValue(e?.currentTarget?.value ?? "")}
              placeholder="例: 5000"
            />

            {/* 商品券で払った額（注文の取引から。読めないときだけ手で入れる） */}
            {appliedState === "manual" ? (
              <s-text-field
                label="商品券で払った額（円）"
                value={appliedAmount}
                type="number"
                onInput={(e) => setAppliedAmount(e?.currentTarget?.value ?? "")}
                placeholder="注文の支払いを読めなかったので入れてください"
              />
            ) : (
              <Row
                label="商品券で払った額（注文から）"
                value={appliedState === "loading" ? "読み込み中…" : `¥${applied.toLocaleString()}`}
              />
            )}
            {/* 全額反映: 商品券で払った額をそのまま額面に入れる（お釣りなし。違えば直す） */}
            {appliedState !== "loading" && appliedAmount !== "" && applied > 0 ? (
              <s-button kind="secondary" onClick={() => setFaceValue(String(roundMoney(applied)))} disabled={loading}>
                {`払った額 ¥${roundMoney(applied).toLocaleString()} を額面に入れる（全額反映）`}
              </s-button>
            ) : null}

            {/* お釣り（自動） */}
            <Row
              label="お釣り（額面 − 払った額）"
              value={changeAmount == null ? "-" : `¥${changeAmount.toLocaleString()}`}
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
// 「変更」フォーム（前の登録を無効にし、直した内容の登録を足す）
// ──────────────────────────────────────────────

/** 「変更」できる登録か（有効で、Shopify 返金の結果が分かっている） */
function canEditEvent(event) {
  return (
    event?.status === "active" &&
    event?.shopifyRefundStatus !== "pending" &&
    event?.approvalStatus !== "rejected"
  );
}

const EDIT_DATE_MODES = [
  { value: "original", label: "元の日のまま" },
  { value: "today", label: "今日の分にする" },
];

function AdjustmentEditForm({ order, event, loading, error, setLoading, setError, onBack, onSuccess }) {
  const isVoucher = event.eventType === "voucher_change_adjustment";
  const needsMethod = event.eventType === "cash_refund" || event.eventType === "payment_method_override";
  // 純正の返金の付け替え: 金額と数える日は変えられない（返した手段とメモだけ直す）
  const isNative = event.refundSource === "native";
  const refundDone = event.shopifyRefundStatus === "success" && !isNative;
  const [amount, setAmount] = useState(String(Number(event.amount ?? 0)));
  const [faceValue, setFaceValue] = useState(String(Number(event.voucherFaceValue ?? 0)));
  const [actualRefundMethod, setActualRefundMethod] = useState(event.actualRefundMethod ?? "");
  const [refundMethods, setRefundMethods] = useState([]);
  const [refundMethodsState, setRefundMethodsState] = useState(needsMethod ? "loading" : "ready");
  const [adjustKind, setAdjustKind] = useState(event.adjustKind ?? "undo");
  const [dateMode, setDateMode] = useState("original");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!needsMethod) return;
    listSelectablePaymentMethods({ sync: false })
      .then((res) => {
        const items = res.items ?? [];
        setRefundMethods(items);
        setRefundMethodsState(items.length > 0 ? "ready" : "empty");
        if (!items.some((m) => m.value === event.actualRefundMethod)) {
          setActualRefundMethod(items[0]?.value ?? "");
        }
      })
      .catch(() => {
        setRefundMethods([]);
        setRefundMethodsState("error");
      });
  }, [event.id]);

  const applied = Number(event.voucherAppliedAmount ?? 0);
  const face = Number(faceValue);
  const change = isVoucher && !isNaN(face) ? Math.max(0, face - applied) : null;

  const handleConfirm = () => {
    setError("");
    if (!reason.trim()) {
      setError("直したわけを入れてください");
      return;
    }
    if (isVoucher) {
      if (!faceValue || isNaN(face) || face <= 0) {
        setError("商品券の額面を入れてください");
        return;
      }
    } else if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      setError("金額を正しく入力してください");
      return;
    }
    if (needsMethod && !refundMethods.some((m) => m.value === actualRefundMethod)) {
      setError(refundMethodsMessage(refundMethodsState) || "返金方法を選んでください");
      return;
    }
    setConfirming(true);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    try {
      const body = {
        reason: reason.trim(),
        dateMode,
        ...(isVoucher ? { voucherFaceValue: face } : { amount: Number(amount) }),
        ...(needsMethod ? { actualRefundMethod } : {}),
        ...(event.eventType === "receipt_cash_adjustment" ? { adjustKind } : {}),
      };
      const res = await editSpecialRefund(event.id, body);
      setConfirming(false);
      const parts = ["変更しました（前の登録は無効にして、直した内容で登録しました）。"];
      if (res?.warning) parts.push(res.warning);
      if (res?.settlementAlreadyConfirmed) {
        const days = (res.confirmedDates ?? []).map(shortDateLabel).join("・");
        parts.push(
          `${days ? `${days} の` : "この日の"}精算はもう確定しています。精算の画面でその日を開き「更新」を押し、「今の数で再確定する」を押してください。`,
        );
      }
      if (res?.metafieldWritten === false) {
        parts.push("注文への記録はまだ書けていません。あとで開き直すと書き直します。");
      }
      await onSuccess({ tone: res?.warning || res?.settlementAlreadyConfirmed ? "warning" : "info", text: parts.join(" ") });
    } catch (e) {
      setError(toUserMessage(e?.message) || "変更に失敗しました");
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  };

  const label = adjustmentKindLabel(event);
  const methodLabel = (v) => refundMethods.find((m) => m.value === v)?.label ?? v ?? "-";

  if (confirming) {
    return (
      <s-page heading={`${label}を変更`}>
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="base">
              <s-text type="strong">前の登録を無効にして、次の内容で登録し直します</s-text>
              <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack gap="small">
                  <Row label="取引" value={order?.orderName ?? "-"} />
                  <Row label="種別" value={label} />
                  {isVoucher ? (
                    <>
                      <Row label="商品券額面" value={`¥${face.toLocaleString()}`} />
                      <Row label="お釣り" value={`¥${Number(change ?? 0).toLocaleString()}`} />
                    </>
                  ) : (
                    <Row label="金額" value={`¥${Number(amount).toLocaleString()}`} />
                  )}
                  {needsMethod ? <Row label="返金方法" value={methodLabel(actualRefundMethod)} /> : null}
                  <Row label="数える日" value={EDIT_DATE_MODES.find((d) => d.value === dateMode)?.label ?? dateMode} />
                  <Row label="わけ" value={reason.trim()} />
                </s-stack>
              </s-box>
              {refundDone ? (
                <s-text tone="critical" fontSize="small">
                  Shopify の返金は直しません（アプリの記録だけを直します）。
                </s-text>
              ) : null}
              {error ? <s-text tone="critical">{error}</s-text> : null}
              <s-stack gap="small">
                <s-button kind="primary" onClick={handleSubmit} loading={loading}>
                  変更する
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
    <s-page heading={`${label}を変更`}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            {/* 元の支払い。特殊返金は「全額反映」で金額を入れる（元の支払手段は前の登録のまま） */}
            <OrderTenderPanel
              order={order}
              lines={orderTenderLines(order)}
              onFill={isVoucher || isNative ? null : (line) => setAmount(String(fullAmountForRefund(line)))}
              disabled={loading}
            />
            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="extraSmall">
                <s-text tone="subdued" fontSize="small">
                  前の登録は無効にして残し、直した内容で登録し直します。
                </s-text>
                {refundDone ? (
                  <s-text tone="critical" fontSize="small">
                    この登録は Shopify でも返金済みです。Shopify の返金は直りません。金額を変えるときは Shopify の管理画面でも直してください。
                  </s-text>
                ) : null}
              </s-stack>
            </s-box>

            {isVoucher ? (
              <>
                <s-text-field
                  label="受け取った商品券の額面（円）"
                  value={faceValue}
                  type="number"
                  onInput={(e) => setFaceValue(e?.currentTarget?.value ?? "")}
                />
                <Row label="商品券で払った額" value={`¥${applied.toLocaleString()}`} />
                <Row label="お釣り" value={change == null ? "-" : `¥${change.toLocaleString()}`} />
              </>
            ) : isNative ? (
              <s-stack gap="none">
                <Row label="金額（純正の返金のまま）" value={`¥${Number(amount).toLocaleString()}`} />
                <s-text tone="subdued" fontSize="small">分け方を変えるときは、無効にしてから変更し直してください。</s-text>
              </s-stack>
            ) : (
              <s-text-field
                label="金額（円）"
                value={amount}
                type="number"
                onInput={(e) => setAmount(e?.currentTarget?.value ?? "")}
              />
            )}

            {needsMethod ? (
              refundMethods.length > 0 ? (
                <PosChoiceField
                  label="返金方法"
                  value={actualRefundMethod}
                  options={refundMethods}
                  onChange={setActualRefundMethod}
                />
              ) : (
                <s-text tone={refundMethodsState === "loading" ? "subdued" : "critical"} fontSize="small">
                  {refundMethodsMessage(refundMethodsState)}
                </s-text>
              )
            ) : null}

            {event.eventType === "receipt_cash_adjustment" ? (
              <PosChoiceField
                label="調整種別"
                value={adjustKind}
                options={ADJUST_KINDS}
                onChange={setAdjustKind}
              />
            ) : null}

            {/* 商品券は注文の日で数えるので、数える日は選ばない */}
            {isVoucher || isNative ? null : (
              <PosChoiceField
                label="数える日"
                value={dateMode}
                options={EDIT_DATE_MODES}
                onChange={setDateMode}
              />
            )}

            <s-text-field
              label="直したわけ（必須）"
              value={reason}
              onInput={(e) => setReason(e?.currentTarget?.value ?? "")}
              placeholder="例: 返金方法の選び間違い"
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

/** "2026-11-23" → "11/23" */
function shortDateLabel(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ""));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(isoDate ?? "");
}
