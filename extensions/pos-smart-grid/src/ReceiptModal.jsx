/**
 * 領収書モーダル
 * 要件書 §8, §23.3
 *
 * Steps:
 *   day_list → ロケーション・年月日ヘッダー＋その日の取引一覧（バッジ付き）
 *   form     → 宛名・但し書き入力
 *   preview  → 領収書プレビュー
 *   confirm  → 発行確認
 *   done     → 完了
 *   history  → 発行履歴
 */
import { render } from "preact";
import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import { getOrder } from "../../common/orderPickerApi.js";
import { previewReceipt, issueReceipt, getReceiptHistory } from "../../common/receiptApi.js";
import { printGiftReceipt, printResultMessage, PRINT_OUTCOME } from "../../common/printApi.js";
import { toUserMessage } from "../../common/errorMessage.js";
import { OrderDayListScreen } from "./OrderDayListScreen.jsx";
import { LoadingPage } from "./LoadingNotice.jsx";
import { fmtYen } from "./orderDisplayUtils.js";
import { formatOrderDateTimeLabel } from "../../common/orderListLabels.js";
import { PosToggleField } from "./PosChoiceField.jsx";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";
import { customerLabel } from "../../common/orderDetailLayout.js";

const STORAGE_KEY = "pos_receipt_order_id";

export default async () => {
  render(<ReceiptModal />, document.body);
};

// ── Root ──────────────────────────────────────────────────────────────────────
function ReceiptModal() {
  const [step, setStep] = useState("day_list");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [recipientName, setRecipientName] = useState("");
  const [proviso, setProviso] = useState("お買上品代として");
  const [preview, setPreview] = useState(null);
  const [issuedReceipt, setIssuedReceipt] = useState(null);
  const [isReissue, setIsReissue] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [orderEntryLoading, setOrderEntryLoading] = useState(false);
  const [bootstrapError, setBootstrapError] = useState("");

  // 取引詳細画面から起動した場合
  useEffect(() => {
    const preId = sessionStorage.getItem(STORAGE_KEY);
    if (preId) {
      sessionStorage.removeItem(STORAGE_KEY);
      setOrderEntryLoading(true);
      setBootstrapError("");
      getOrder(preId)
        .then((order) => {
          setSelectedOrder(order);
          setStep("form");
        })
        .catch((e) => setBootstrapError(toUserMessage(e?.message) || "取得に失敗しました"))
        .finally(() => setOrderEntryLoading(false));
    }
  }, []);

  const handleOrderSelect = useCallback(async (orderId) => {
    setLoading(true);
    setError("");
    setBootstrapError("");
    try {
      const order = await getOrder(orderId);
      setSelectedOrder(order);
      setStep("form");
    } catch (e) {
      setBootstrapError(toUserMessage(e?.message) || "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const handlePreview = useCallback(async () => {
    if (!selectedOrder) return;
    setLoading(true);
    setError("");
    try {
      const res = await previewReceipt({
        orderId: selectedOrder.orderId,
        recipientName,
        proviso,
      });
      setPreview(res.preview);
      setStep("preview");
    } catch (e) {
      setError(toUserMessage(e?.message) || "プレビューの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedOrder, recipientName, proviso]);

  const handleIssue = useCallback(async () => {
    if (!selectedOrder) return;
    setLoading(true);
    setError("");
    try {
      const res = await issueReceipt({
        orderId: selectedOrder.orderId,
        recipientName,
        proviso,
        isReissue,
      });
      setIssuedReceipt(res.receipt);
      setStep("done");
    } catch (e) {
      setError(toUserMessage(e?.message) || "発行に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedOrder, recipientName, proviso, isReissue]);

  const goBack = useCallback(() => {
    setSelectedOrder(null);
    setPreview(null);
    setIssuedReceipt(null);
    setError("");
    setBootstrapError("");
    setStep("day_list");
  }, []);

  if (orderEntryLoading) {
    return <LoadingPage heading="領収書" />;
  }

  if (step === "day_list") {
    return (
      <OrderDayListScreen
        pageHeading="領収書（取引を選択）"
        badgeMode="receipt"
        onSelectOrderId={handleOrderSelect}
        noticeError={bootstrapError}
        busy={loading}
        onDismissNotice={() => setBootstrapError("")}
        footerTrailing={(
          <s-button variant="secondary" onClick={() => setStep("history")}>
            履歴
          </s-button>
        )}
      />
    );
  }

  if (step === "form") {
    return (
      <FormView
        order={selectedOrder}
        recipientName={recipientName}
        proviso={proviso}
        isReissue={isReissue}
        loading={loading}
        error={error}
        setRecipientName={setRecipientName}
        setProviso={setProviso}
        setIsReissue={setIsReissue}
        setError={setError}
        onPreview={handlePreview}
        onBack={goBack}
      />
    );
  }

  if (step === "preview") {
    return (
      <PreviewView
        preview={preview}
        isReissue={isReissue}
        loading={loading}
        error={error}
        onConfirm={() => setStep("confirm")}
        onEdit={() => setStep("form")}
        onBack={() => setStep("form")}
      />
    );
  }

  if (step === "confirm") {
    return (
      <ConfirmView
        preview={preview}
        isReissue={isReissue}
        loading={loading}
        error={error}
        onIssue={handleIssue}
        onBack={() => setStep("preview")}
      />
    );
  }

  if (step === "done") {
    return (
      <DoneView
        receipt={issuedReceipt}
        onClose={goBack}
        onReissue={() => {
          setIsReissue(true);
          setIssuedReceipt(null);
          setPreview(null);
          setStep("form");
        }}
      />
    );
  }

  if (step === "history") {
    return <HistoryView onBack={() => setStep("day_list")} />;
  }

  return null;
}

// ── 入力フォーム ──────────────────────────────────────────────────────────────
function FormView({
  order, recipientName, proviso, isReissue,
  loading, error,
  setRecipientName, setProviso, setIsReissue, setError,
  onPreview, onBack,
}) {
  const orderSubLine = [
    order?.transactionDateTime || "",
    order?.location?.name || "",
    customerLabel(order),
  ]
    .filter(Boolean)
    .join(" ・ ");

  const handleNext = () => {
    setError("");
    onPreview();
  };

  return (
    <s-page heading="領収書情報を入力">
      <s-stack
        gap="none"
        blockSize="100%"
        inlineSize="100%"
        minBlockSize="0"
        style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
      >
        <s-scroll-box
          blockSize="auto"
          maxBlockSize="100%"
          minBlockSize="0"
          style={{ flex: "1 1 0", minHeight: 0 }}
        >
          <s-box padding="base">
            <s-stack gap="base">
              {/* 対象取引（一覧の行と同じ形: 番号・金額は太字、日時・店舗・顧客は灰色の小さい字） */}
              <s-stack gap="small-300">
                <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                  <s-text type="strong">{order?.orderName ?? "-"}</s-text>
                  <s-text type="strong">¥{Number(order?.totalPrice?.amount ?? 0).toLocaleString("ja-JP")}</s-text>
                </s-stack>
                {orderSubLine ? <s-text type="small" color="subdued">{orderSubLine}</s-text> : null}
              </s-stack>

              <s-stack gap="small">
                <s-text type="small" color="subdued">領収書に書く内容</s-text>
                <s-text-field
                  label="宛名"
                  value={recipientName}
                  onInput={(e) => setRecipientName(e?.currentTarget?.value ?? "")}
                  placeholder="例: 株式会社○○ 御中"
                />
                <s-text-field
                  label="但し書き"
                  value={proviso}
                  onInput={(e) => setProviso(e?.currentTarget?.value ?? "")}
                  placeholder="例: お買上品代として"
                />
              </s-stack>

              <s-stack gap="small-300">
                <s-text type="small" color="subdued">再発行</s-text>
                <PosToggleField label="再発行として記録する" checked={isReissue} onChange={setIsReissue} />
                <s-text type="small" color="subdued">
                  前に出した領収書を出し直すときだけチェック。領収書に【再発行】と入ります。
                </s-text>
              </s-stack>

              {error ? <s-text tone="critical">{error}</s-text> : null}
            </s-stack>
          </s-box>
        </s-scroll-box>

        <s-divider />

        {/* 次に押すボタンを下に固定。「プレビューを確認」だけ色付き（精算の「精算」と同じ） */}
        <FixedFooterNavBar
          centerAlignWithButtons
          leftLabel="戻る"
          onLeft={onBack}
          leftDisabled={loading}
          rightLabel="プレビューを確認"
          onRight={handleNext}
          rightTone="success"
          rightLoading={loading}
          rightDisabled={loading}
        />
      </s-stack>
    </s-page>
  );
}

// ── プレビュー ────────────────────────────────────────────────────────────────
function PreviewView({ preview, isReissue, loading, error, onConfirm, onEdit, onBack }) {
  if (!preview) return null;

  return (
    <s-page heading={isReissue ? "領収書プレビュー（再発行）" : "領収書プレビュー"}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">

            {/* 領収書イメージ */}
            <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="small">
                <s-text fontWeight="bold" fontSize="large">領　収　書</s-text>
                {isReissue ? <s-text tone="critical" fontSize="small">【再発行】</s-text> : null}

                <s-stack direction="horizontal" align="space-between">
                  <s-text>{preview.recipientName ? `${preview.recipientName} 様` : "　　　　　 様"}</s-text>
                  {preview.showDate ? <s-text tone="subdued" fontSize="small">{preview.issueDate}</s-text> : null}
                </s-stack>

                <s-box paddingBlock="small" borderBlockStartWidth="base" borderColor="subdued">
                  <s-stack direction="horizontal" align="space-between">
                    <s-text>金額</s-text>
                    <s-text fontWeight="bold" fontSize="large">¥{Number(preview.amount).toLocaleString()}</s-text>
                  </s-stack>
                </s-box>

                <s-text tone="subdued" fontSize="small">但し {preview.proviso}</s-text>

                {preview.showOrderNumber ? (
                  <s-text tone="subdued" fontSize="small">注文番号: {preview.orderName}</s-text>
                ) : null}

                {preview.companyName ? (
                  <s-box paddingBlockStart="small" borderBlockStartWidth="base" borderColor="subdued">
                    <s-stack gap="extraSmall">
                      <s-text fontWeight="bold">{preview.companyName}</s-text>
                      {preview.address ? <s-text tone="subdued" fontSize="small">{preview.address}</s-text> : null}
                      {preview.phone ? <s-text tone="subdued" fontSize="small">TEL: {preview.phone}</s-text> : null}
                    </s-stack>
                  </s-box>
                ) : null}
              </s-stack>
            </s-box>

            {error ? <s-text tone="critical">{error}</s-text> : null}

            <s-stack gap="small">
              <s-button kind="primary" onClick={onConfirm} disabled={loading}>
                {isReissue ? "再発行する" : "発行する"}
              </s-button>
              <s-button kind="secondary" onClick={onEdit} disabled={loading}>内容を修正する</s-button>
              <s-button kind="plain" onClick={onBack} disabled={loading}>← 戻る</s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 発行確認 ──────────────────────────────────────────────────────────────────
function ConfirmView({ preview, isReissue, loading, error, onIssue, onBack }) {
  return (
    <s-page heading="発行確認">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text fontWeight="bold">
              {isReissue ? "領収書を再発行します" : "領収書を発行します"}
            </s-text>

            <s-box padding="small" borderWidth="base" borderRadius="base" borderColor="subdued">
              <s-stack gap="small">
                <Row label="宛名" value={preview?.recipientName || "（未入力）"} />
                <Row label="金額" value={`¥${Number(preview?.amount ?? 0).toLocaleString()}`} bold />
                <Row label="但し書き" value={preview?.proviso ?? ""} />
                <Row label="注文番号" value={preview?.orderName ?? ""} />
                <Row label="発行日" value={preview?.issueDate ?? ""} />
                {isReissue ? <s-text tone="critical" fontSize="small">※ 再発行として記録されます</s-text> : null}
              </s-stack>
            </s-box>

            {error ? <s-text tone="critical">{error}</s-text> : null}

            <s-stack gap="small">
              <s-button kind="primary" onClick={onIssue} loading={loading}>発行する</s-button>
              <s-button kind="secondary" onClick={onBack} disabled={loading}>戻る</s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 完了 ──────────────────────────────────────────────────────────────────────
function ReceiptPrintControls({ receiptIssueId }) {
  const [printBusy, setPrintBusy] = useState(false);
  const [printMsg, setPrintMsg] = useState("");
  const [canDialog, setCanDialog] = useState(false);
  const [outcome, setOutcome] = useState("");

  const runPrint = async (allowDialog) => {
    if (!receiptIssueId || printBusy) return;
    setPrintBusy(true);
    setPrintMsg("");
    try {
      const res = await printGiftReceipt(receiptIssueId, { allowDialog });
      setOutcome(res.outcome || "");
      setCanDialog(!!res.canUseDialog);
      setPrintMsg(printResultMessage(res));
    } catch (e) {
      setOutcome(PRINT_OUTCOME.FAILED);
      setPrintMsg(toUserMessage(e?.message) || "印刷できませんでした");
    } finally {
      setPrintBusy(false);
    }
  };

  if (!receiptIssueId) {
    return <s-text tone="critical">領収書の記録が見つからないため印刷できません</s-text>;
  }

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack gap="small">
        <s-text tone="subdued" fontSize="small">
          保存済みの領収書を印刷します。印刷し直しても売上・返金・精算は増えません。
        </s-text>
        <s-button variant="primary" onClick={() => runPrint(false)} disabled={printBusy}>
          {printBusy ? "印刷中…" : "領収書を印刷する"}
        </s-button>
        {canDialog ? (
          <s-button onClick={() => runPrint(true)} disabled={printBusy}>
            ほかのプリンタを選んで印刷する
          </s-button>
        ) : null}
        {printMsg ? (
          <s-text tone={outcome === PRINT_OUTCOME.DIRECT_ACCEPTED ? "subdued" : "caution"}>
            {printMsg}
          </s-text>
        ) : null}
      </s-stack>
    </s-box>
  );
}

function DoneView({ receipt, onClose, onReissue }) {
  const receiptSummary = (
    <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack gap="small">
        <s-text fontWeight="bold" fontSize="large">領　収　書</s-text>
        {receipt?.isReissue ? <s-text tone="critical" fontSize="small">【再発行】</s-text> : null}
        <Row label="宛名" value={receipt?.recipientName || "（未入力）"} />
        <Row label="金額" value={`¥${Number(receipt?.amount ?? 0).toLocaleString()}`} bold />
        <Row label="但し書き" value={receipt?.proviso ?? ""} />
        <Row label="注文番号" value={receipt?.orderName ?? ""} />
        <Row label="発行日" value={receipt?.issueDate ?? ""} />
        {receipt?.companyName ? <Row label="発行者" value={receipt.companyName} /> : null}
      </s-stack>
    </s-box>
  );

  return (
    <s-page heading="発行完了">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text fontWeight="bold">
              {receipt?.isReissue ? "領収書を再発行しました" : "領収書を発行しました"}
            </s-text>
            <ReceiptPrintControls receiptIssueId={receipt?.receiptIssueId} />
            {receiptSummary}
            <s-text tone="subdued" fontSize="small">
              発行ID: …{receipt?.receiptIssueId?.slice(-8) ?? ""}
            </s-text>
            <s-stack gap="small">
              <s-button kind="secondary" onClick={onReissue}>同じ取引を再発行する</s-button>
              <s-button kind="plain" onClick={onClose}>閉じる</s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

// ── 発行履歴 ──────────────────────────────────────────────────────────────────
/**
 * 発行履歴も、取引を選ぶ一覧と同じ見た目・作りにする（T 2026-11-23）。
 * 上に検索欄・年月日・「店名・時刻 に更新」を固定、行は「#1017 • 宛名 様」と金額、灰色の発行日時、再発行のバッジ。
 * 出すのは POS の今の店で発行したものだけ。行は押せない（前と同じ）。
 */
async function fetchReceiptHistoryPage(params) {
  const res = await getReceiptHistory({
    locationId: params.locationId,
    q: params.q,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    limit: 50,
  });
  return {
    items: res.items ?? [],
    nextCursor: null,
    todayLocalDate: res.todayLocalDate ?? "",
    fetchedAtTime: res.fetchedAtTime ?? "",
  };
}

function receiptHistoryRow(item, todayKey) {
  const name = String(item.orderName ?? "").trim();
  const recipient = String(item.recipientName ?? "").trim();
  const when = formatOrderDateTimeLabel(item, todayKey);
  return {
    key: item.id,
    title: recipient ? `${name} • ${recipient} 様` : name,
    amountLabel: fmtYen(item.amount),
    dateTimeLabel: when ? `${when} 発行` : "",
    badges: item.isReissue ? [{ key: "reissue", label: "再発行", tone: "caution" }] : [],
  };
}

function HistoryView({ onBack }) {
  // 一覧の行を押すと、保存済みの領収書を再印刷する画面を開く（#53 の再印刷を一覧の形に合わせた）
  const itemsById = useRef(new Map());
  const [reprintItem, setReprintItem] = useState(null);

  if (reprintItem) {
    const recipient = String(reprintItem.recipientName ?? "").trim();
    return (
      <s-page heading="領収書を再印刷">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="small">
              <s-text type="strong">{reprintItem.orderName}</s-text>
              <s-text color="subdued">宛名: {recipient || "（未入力）"}{reprintItem.isReissue ? "（再発行）" : ""}</s-text>
              <s-text color="subdued">金額: {fmtYen(reprintItem.amount)}</s-text>
              <ReceiptPrintControls receiptIssueId={reprintItem.id} />
            </s-stack>
          </s-box>
        </s-scroll-box>
        <FixedFooterNavBar centerAlignWithButtons leftLabel="戻る" onLeft={() => setReprintItem(null)} />
      </s-page>
    );
  }

  return (
    <OrderDayListScreen
      pageHeading="領収書発行履歴"
      badgeMode="receipt"
      fetchList={fetchReceiptHistoryPage}
      toRow={(item, todayKey) => {
        itemsById.current.set(item.id, item);
        return { ...receiptHistoryRow(item, todayKey), selectId: item.id };
      }}
      onSelectOrderId={(id) => setReprintItem(itemsById.current.get(id) ?? null)}
      itemNoun="発行"
      searchPlaceholder="注文番号・宛名で検索"
      searchHint="注文番号は数字だけでも探せます。宛名は 2 文字以上入れてください。"
      onBack={onBack}
    />
  );
}

// ── ヘルパー ──────────────────────────────────────────────────────────────────
function Row({ label, value, bold = false }) {
  return (
    <s-stack direction="horizontal" align="space-between">
      <s-text tone="subdued" fontSize="small">{label}</s-text>
      <s-text fontWeight={bold ? "bold" : undefined}>{value}</s-text>
    </s-stack>
  );
}
