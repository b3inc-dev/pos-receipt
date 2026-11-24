/**
 * 領収書モーダル
 * 要件書 §8, §23.3
 *
 * Steps:
 *   day_list → ロケーション・年月日ヘッダー＋その日の取引一覧（バッジ付き）
 *   form     → 宛名・但し書き入力
 *   preview  → 発行の確認（前のプレビューと発行確認を 1 画面にまとめた。T 2026-11-24 の UI ルール）
 *   done     → 完了（ここから印刷）
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
import { FormHeading, FormLine, FormHero, yen } from "./AdjustFormParts.jsx";
import { summarizePriorReceipts, reissueHelpText } from "../../common/receiptReissue.js";

const STORAGE_KEY = "pos_receipt_order_id";
const PRIOR_CHECK_TIMEOUT_MS = 10000;

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
  // この注文で前に領収書を発行したか（T 2026-11-24: 発行したことがある注文は「再発行」を初めからオンにする。手で外せる）
  const [prior, setPrior] = useState({ state: "idle", summary: null });
  const priorSeq = useRef(0);
  const reissueTouched = useRef(false);
  const isReissueRef = useRef(false);
  isReissueRef.current = isReissue;

  /** 注文を開いたとき: 再発行の選択を戻し、この注文の発行の記録を見にいく */
  const openOrder = useCallback((order) => {
    setSelectedOrder(order);
    setIsReissue(false);
    reissueTouched.current = false;
    const seq = ++priorSeq.current;
    const orderId = order?.orderId;
    if (!orderId) {
      setPrior({ state: "failed", summary: null });
      return;
    }
    setPrior({ state: "loading", summary: null });
    // 通信が固まって「確認する」が押せないままにならないよう、10 秒で失敗に倒す
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), PRIOR_CHECK_TIMEOUT_MS);
    });
    Promise.race([
      getReceiptHistory({ orderId: String(orderId).replace("gid://shopify/Order/", ""), limit: 50 }),
      timeout,
    ])
      .finally(() => clearTimeout(timer))
      .then((res) => {
        if (seq !== priorSeq.current) return;
        const summary = summarizePriorReceipts(res?.items, res?.todayLocalDate);
        setPrior({ state: "done", summary });
        // 店の人がまだ触っていなければ、発行したことがある注文はオンにする
        if (summary.issuedBefore && !reissueTouched.current) setIsReissue(true);
      })
      .catch(() => {
        if (seq !== priorSeq.current) return;
        setPrior({ state: "failed", summary: null });
      });
  }, []);

  /** 確かめ直し: 店の人がもう選んでいたら、その選択は残す */
  const openOrderKeepReissue = useCallback((order) => {
    const touched = reissueTouched.current;
    const current = isReissueRef.current;
    openOrder(order);
    if (touched) {
      reissueTouched.current = true;
      setIsReissue(current);
    }
  }, [openOrder]);

  const changeReissue = useCallback((next) => {
    reissueTouched.current = true;
    setIsReissue(next);
  }, []);

  // 取引詳細画面から起動した場合
  useEffect(() => {
    const preId = sessionStorage.getItem(STORAGE_KEY);
    if (preId) {
      sessionStorage.removeItem(STORAGE_KEY);
      setOrderEntryLoading(true);
      setBootstrapError("");
      getOrder(preId)
        .then((order) => {
          openOrder(order);
          setStep("form");
        })
        .catch((e) => setBootstrapError(toUserMessage(e?.message) || "取得に失敗しました"))
        .finally(() => setOrderEntryLoading(false));
    }
  }, [openOrder]);

  const handleOrderSelect = useCallback(async (orderId) => {
    setLoading(true);
    setError("");
    setBootstrapError("");
    try {
      const order = await getOrder(orderId);
      openOrder(order);
      setStep("form");
    } catch (e) {
      setBootstrapError(toUserMessage(e?.message) || "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [openOrder]);

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
      setError(toUserMessage(e?.message) || "内容を確かめられませんでした。もう一度押してください");
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
    priorSeq.current += 1;
    setPrior({ state: "idle", summary: null });
    setIsReissue(false);
    reissueTouched.current = false;
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
        prior={prior}
        onRetryPrior={() => openOrderKeepReissue(selectedOrder)}
        loading={loading}
        error={error}
        setRecipientName={setRecipientName}
        setProviso={setProviso}
        setIsReissue={changeReissue}
        setError={setError}
        onPreview={handlePreview}
        onBack={goBack}
      />
    );
  }

  if (step === "preview") {
    return (
      <ConfirmView
        preview={preview}
        isReissue={isReissue}
        loading={loading}
        error={error}
        onIssue={handleIssue}
        onBack={() => setStep("form")}
      />
    );
  }

  if (step === "done") {
    return (
      <DoneView receipt={issuedReceipt} onClose={goBack} />
    );
  }

  if (step === "history") {
    return <HistoryView onBack={() => setStep("day_list")} />;
  }

  return null;
}

// ── 入力フォーム ──────────────────────────────────────────────────────────────
function FormView({
  order, recipientName, proviso, isReissue, prior, onRetryPrior,
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
    <s-page heading="領収書を発行">
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
              {/* 対象取引（注文の詳細と同じ形: 灰色の見出し・左に項目・右に値） */}
              <s-stack gap="none">
                <FormHeading>取引</FormHeading>
                <FormLine label={order?.orderName ?? "-"} value={yen(order?.totalPrice?.amount)} strong />
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
                {prior?.state === "failed" ? (
                  <s-banner tone="warning" heading="前に発行したかを確かめられませんでした">
                    <s-stack gap="small">
                      <s-text>出し直しのときは「再発行として記録する」を選んでください。</s-text>
                      <s-stack direction="inline" justifyContent="end">
                        <s-button variant="secondary" onClick={onRetryPrior} disabled={loading}>
                          もう一度確かめる
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </s-banner>
                ) : null}
                {prior?.summary?.issuedBefore ? <s-text>{prior.summary.notice}</s-text> : null}
                <PosToggleField label="再発行として記録する" checked={isReissue} onChange={setIsReissue} />
                <s-text type="small" color="subdued">
                  {prior?.state === "loading"
                    ? "前に発行したかを確かめています（読み込み中…）"
                    : prior?.state === "failed"
                      ? "選ばずに発行すると、管理画面の発行履歴で「再発行を外して発行」と出ることがあります。"
                      : reissueHelpText(prior?.summary, isReissue)}
                </s-text>
              </s-stack>

              {error ? <s-text tone="critical">{error}</s-text> : null}
            </s-stack>
          </s-box>
        </s-scroll-box>

        <s-divider />

        {/* 下に固定: 左「戻る」・右に主ボタン 1 つ（ほかの入力画面と同じ「確認する」） */}
        <FixedFooterNavBar
          centerAlignWithButtons
          leftLabel="戻る"
          onLeft={onBack}
          leftDisabled={loading}
          rightLabel="確認する"
          onRight={handleNext}
          rightLoading={loading}
          rightDisabled={loading || prior?.state === "loading"}
        />
      </s-stack>
    </s-page>
  );
}

// ── 確認（発行する前に内容を確かめる） ─────────────────────────────────────────
/**
 * 注文の詳細と同じ形（T 2026-11-24）: 本文 1 文 → 金額を大きく → 灰色の見出しで区切った「左に項目・右に値」の行。
 * 下に固定で「戻る」（左）と「発行する」（右）。前は「プレビュー」と「発行確認」の 2 画面で同じ内容を
 * 2 回見せていたので、1 画面にまとめた。
 */
function ConfirmView({ preview, isReissue, loading, error, onIssue, onBack }) {
  if (!preview) return null;
  const action = isReissue ? "再発行する" : "発行する";
  return (
    <s-page heading={isReissue ? "領収書を再発行" : "領収書を発行"}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="none">
            <s-text>{isReissue ? "この内容で領収書を再発行します。" : "この内容で領収書を発行します。"}</s-text>
            <s-box paddingBlockStart="base">
              <FormHero
                label="金額"
                value={yen(preview.amount)}
                sub={preview.recipientName ? `${preview.recipientName} 様` : "宛名なし"}
              />
            </s-box>
            <ReceiptLines receipt={preview} isReissue={isReissue} />
            {error ? (
              <s-box paddingBlockStart="base">
                <s-text tone="critical">{error}</s-text>
              </s-box>
            ) : null}
          </s-stack>
        </s-box>
      </s-scroll-box>
      <FixedFooterNavBar
        centerAlignWithButtons
        leftLabel="戻る"
        onLeft={onBack}
        leftDisabled={loading}
        rightLabel={action}
        onRight={onIssue}
        rightDisabled={loading}
        rightLoading={loading}
      />
    </s-page>
  );
}

/** 領収書の中身の行（確認・完了・再印刷で同じもの） */
function ReceiptLines({ receipt, isReissue }) {
  return (
    <>
      <FormHeading>領収書の内容</FormHeading>
      <FormLine label="宛名" value={receipt?.recipientName ? `${receipt.recipientName} 様` : "（なし）"} />
      <FormLine label="但し書き" value={receipt?.proviso || "（なし）"} />
      {receipt?.issueDate ? <FormLine label="発行日" value={receipt.issueDate} /> : null}
      {isReissue ? <FormLine label="種類" value="再発行" tone="critical" /> : null}
      <FormHeading>取引</FormHeading>
      <FormLine label="注文番号" value={receipt?.orderName || "—"} />
      {receipt?.companyName ? <FormLine label="発行者" value={receipt.companyName} /> : null}
    </>
  );
}

// ── 印刷 ──────────────────────────────────────────────────────────────────────
/** 保存済みの領収書を印刷する（完了・再印刷の画面の右下の「印刷する」） */
function useReceiptPrint(receiptIssueId) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [canDialog, setCanDialog] = useState(false);
  const [outcome, setOutcome] = useState("");

  const run = async (allowDialog = false) => {
    if (!receiptIssueId || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await printGiftReceipt(receiptIssueId, { allowDialog });
      setOutcome(res.outcome || "");
      setCanDialog(!!res.canUseDialog);
      setMsg(printResultMessage(res));
    } catch (e) {
      setOutcome(PRINT_OUTCOME.FAILED);
      setMsg(toUserMessage(e?.message) || "印刷できませんでした");
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, msg, canDialog, outcome };
}

/** 印刷の結果（押したボタンの近く＝本文のいちばん下）。うまくいかなかったときだけ「ほかのプリンタ」を小さく出す */
function PrintResult({ print, receiptIssueId }) {
  if (!receiptIssueId) {
    return (
      <s-box paddingBlockStart="base">
        <s-text tone="critical">領収書の記録が見つからないため印刷できません</s-text>
      </s-box>
    );
  }
  if (!print.msg) {
    return (
      <s-box paddingBlockStart="base">
        <s-text type="small" color="subdued">印刷し直しても、売上・返金・精算の数は変わりません。</s-text>
      </s-box>
    );
  }
  const ok = print.outcome === PRINT_OUTCOME.DIRECT_ACCEPTED;
  return (
    <s-box paddingBlockStart="base">
      <s-stack gap="small">
        <s-text tone={ok ? "success" : "caution"}>{print.msg}</s-text>
        {print.canDialog ? (
          <s-stack direction="inline" justifyContent="end">
            <s-button variant="secondary" onClick={() => print.run(true)} disabled={print.busy}>
              ほかのプリンタで印刷
            </s-button>
          </s-stack>
        ) : null}
      </s-stack>
    </s-box>
  );
}

// ── 完了 ──────────────────────────────────────────────────────────────────────
function DoneView({ receipt, onClose }) {
  const print = useReceiptPrint(receipt?.receiptIssueId);
  return (
    <s-page heading="発行完了">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="none">
            <s-banner tone="success" heading={receipt?.isReissue ? "領収書を再発行しました" : "領収書を発行しました"} />
            <s-box paddingBlockStart="base">
              <FormHero
                label="金額"
                value={yen(receipt?.amount)}
                sub={receipt?.recipientName ? `${receipt.recipientName} 様` : "宛名なし"}
              />
            </s-box>
            <ReceiptLines receipt={receipt} isReissue={Boolean(receipt?.isReissue)} />
            <PrintResult print={print} receiptIssueId={receipt?.receiptIssueId} />
          </s-stack>
        </s-box>
      </s-scroll-box>
      <FixedFooterNavBar
        centerAlignWithButtons
        leftLabel="閉じる"
        onLeft={onClose}
        leftDisabled={print.busy}
        rightLabel="印刷する"
        onRight={() => print.run(false)}
        rightDisabled={print.busy || !receipt?.receiptIssueId}
        rightLoading={print.busy}
      />
    </s-page>
  );
}

/** 発行履歴の行を押したときの再印刷 */
function ReprintView({ item, onBack }) {
  const print = useReceiptPrint(item?.id);
  const receipt = {
    recipientName: String(item?.recipientName ?? "").trim(),
    proviso: item?.proviso,
    orderName: item?.orderName,
  };
  return (
    <s-page heading="領収書を再印刷">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="none">
            <FormHero
              label="金額"
              value={yen(item?.amount)}
              sub={receipt.recipientName ? `${receipt.recipientName} 様` : "宛名なし"}
            />
            <ReceiptLines receipt={receipt} isReissue={Boolean(item?.isReissue)} />
            <PrintResult print={print} receiptIssueId={item?.id} />
          </s-stack>
        </s-box>
      </s-scroll-box>
      <FixedFooterNavBar
        centerAlignWithButtons
        leftLabel="戻る"
        onLeft={onBack}
        leftDisabled={print.busy}
        rightLabel="印刷する"
        onRight={() => print.run(false)}
        rightDisabled={print.busy || !item?.id}
        rightLoading={print.busy}
      />
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
    return <ReprintView item={reprintItem} onBack={() => setReprintItem(null)} />;
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
