/**
 * 販売レシート印字モーダル
 * 注文選択 → プレビュー案内 → shopify.printing
 */
import { render } from "preact";
import { useState, useCallback, useEffect } from "preact/hooks";
import { getOrder } from "../../common/orderPickerApi.js";
import { printSalesReceipt, printResultMessage, PRINT_OUTCOME } from "../../common/printApi.js";
import { toUserMessage } from "../../common/errorMessage.js";
import { OrderDayListScreen } from "./OrderDayListScreen.jsx";
import { LoadingPage } from "./LoadingNotice.jsx";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";
import { PosChoiceField } from "./PosChoiceField.jsx";
import { FormHeading, FormLine, yen } from "./AdjustFormParts.jsx";

const STORAGE_KEY = "pos_sales_receipt_order_id";

export default async () => {
  render(<SalesReceiptModal />, document.body);
};

function SalesReceiptModal() {
  const [step, setStep] = useState("day_list");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [gift, setGift] = useState(false);
  const [printResult, setPrintResult] = useState(null);
  const [bootstrapError, setBootstrapError] = useState("");
  const [orderEntryLoading, setOrderEntryLoading] = useState(false);

  useEffect(() => {
    const preId = sessionStorage.getItem(STORAGE_KEY);
    if (preId) {
      sessionStorage.removeItem(STORAGE_KEY);
      setOrderEntryLoading(true);
      getOrder(preId)
        .then((order) => {
          setSelectedOrder(order);
          setStep("confirm");
        })
        .catch((e) => setBootstrapError(toUserMessage(e?.message) || "取得に失敗しました"))
        .finally(() => setOrderEntryLoading(false));
    }
  }, []);

  const handleOrderSelect = useCallback(async (orderId) => {
    setLoading(true);
    setError("");
    try {
      const order = await getOrder(orderId);
      setGift(false);
      setPrintResult(null);
      setSelectedOrder(order);
      setStep("confirm");
    } catch (e) {
      setError(toUserMessage(e?.message) || "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const handlePrint = useCallback(async (allowDialog = false) => {
    if (!selectedOrder?.orderId || loading) return;
    setLoading(true);
    setError("");
    try {
      const res = await printSalesReceipt(selectedOrder.orderId, { allowDialog, gift });
      setPrintResult(res);
      if (!res.ok) {
        setError(printResultMessage(res));
        return;
      }
      setStep("done");
    } catch (e) {
      setError(toUserMessage(e?.message) || "印刷できませんでした");
    } finally {
      setLoading(false);
    }
  }, [selectedOrder, loading, gift]);

  if (orderEntryLoading) {
    return <LoadingPage heading="販売レシート" />;
  }

  if (step === "day_list") {
    return (
      <OrderDayListScreen
        pageHeading="販売レシート（取引を選択）"
        badgeMode="receipt"
        onSelectOrderId={handleOrderSelect}
        noticeError={bootstrapError || error}
        busy={loading}
        onDismissNotice={() => {
          setBootstrapError("");
          setError("");
        }}
      />
    );
  }

  const backToList = () => {
    setSelectedOrder(null);
    setPrintResult(null);
    setError("");
    setStep("day_list");
  };

  const orderLine = (
    <>
      <FormHeading>取引</FormHeading>
      <FormLine
        label={selectedOrder?.orderName || "注文"}
        value={selectedOrder?.totalPrice?.amount != null ? yen(selectedOrder.totalPrice.amount) : ""}
        strong
      />
      {selectedOrder?.transactionDateTime ? (
        <s-text type="small" color="subdued">{selectedOrder.transactionDateTime}</s-text>
      ) : null}
    </>
  );

  // 完了: 上に結果、下に固定で「閉じる」（左）。もう一度印刷するときは右の「もう一度印刷」
  if (step === "done") {
    const dialog = printResult?.outcome === PRINT_OUTCOME.DIALOG_PRESENTED;
    return (
      <s-page heading="印刷完了">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack gap="none">
              <s-banner
                tone="success"
                heading={dialog ? "印刷の画面を開きました" : `${gift ? "ギフトレシート" : "販売レシート"}をプリンタに送りました`}
              />
              {orderLine}
              <FormLine label="種類" value={gift ? "ギフトレシート（金額なし）" : "販売レシート"} />
              {printResultMessage(printResult) ? (
                <s-box paddingBlockStart="base">
                  <s-text type="small" color="subdued">{printResultMessage(printResult)}</s-text>
                </s-box>
              ) : null}
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
          leftLabel="閉じる"
          onLeft={backToList}
          rightLabel="もう一度印刷"
          onRight={() => handlePrint(false)}
          rightDisabled={loading}
          rightLoading={loading}
        />
      </s-page>
    );
  }

  // 印刷の前: 種類を選んで、右下の「印刷する」
  return (
    <s-page heading="レシートを印刷">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="none">
            {orderLine}
            <FormHeading>レシートの種類</FormHeading>
            <PosChoiceField
              value={gift ? "gift" : "sales"}
              options={[
                { value: "sales", label: "販売レシート" },
                { value: "gift", label: "ギフトレシート（金額なし）" },
              ]}
              onChange={(v) => {
                setGift(v === "gift");
                setPrintResult(null);
                setError("");
              }}
            />
            <s-box paddingBlockStart="small">
              <s-text type="small" color="subdued">
                {gift ? "注文番号・品名・数量を印刷します（金額は出しません）。" : "管理画面の設定に合わせて、金額・注文の項目・商品の項目を印刷します。"}
              </s-text>
            </s-box>
            {error ? (
              <s-box paddingBlockStart="base">
                <s-stack gap="small">
                  <s-text tone="critical">{error}</s-text>
                  {printResult?.canUseDialog ? (
                    <s-stack direction="inline" justifyContent="end">
                      <s-button variant="secondary" onClick={() => handlePrint(true)} disabled={loading}>
                        ほかのプリンタで印刷
                      </s-button>
                    </s-stack>
                  ) : null}
                </s-stack>
              </s-box>
            ) : null}
          </s-stack>
        </s-box>
      </s-scroll-box>
      <FixedFooterNavBar
        centerAlignWithButtons
        leftLabel="戻る"
        onLeft={backToList}
        leftDisabled={loading}
        rightLabel="印刷する"
        onRight={() => handlePrint(false)}
        rightDisabled={loading}
        rightLoading={loading}
      />
    </s-page>
  );
}
