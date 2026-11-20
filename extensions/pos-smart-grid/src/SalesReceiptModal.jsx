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
      setError(toUserMessage(e?.message) || "印字に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedOrder, loading, gift]);

  if (orderEntryLoading) {
    return (
      <s-page heading="販売レシート">
        <s-box padding="base"><s-text>注文を読み込み中…</s-text></s-box>
      </s-page>
    );
  }

  if (step === "day_list") {
    return (
      <OrderDayListScreen
        pageHeading="販売レシート（取引を選択）"
        badgeMode="receipt"
        onSelectOrderId={handleOrderSelect}
        noticeError={bootstrapError || error}
        onDismissNotice={() => {
          setBootstrapError("");
          setError("");
        }}
      />
    );
  }

  if (step === "done") {
    return (
      <s-page heading="印字完了">
        <s-box padding="base">
          <s-stack gap="base">
            <s-text fontWeight="bold">
              {printResult?.outcome === PRINT_OUTCOME.DIALOG_PRESENTED
                ? "システム印刷ダイアログを開きました"
                : `${gift ? "ギフト" : "販売"}レシートをプリンタへ送信しました`}
            </s-text>
            <s-text tone="subdued">
              {selectedOrder?.orderName || selectedOrder?.orderId}
            </s-text>
            <s-text tone="subdued" fontSize="small">
              {printResultMessage(printResult)}
            </s-text>
            <s-button
              variant="primary"
              onClick={() => {
                setSelectedOrder(null);
                setPrintResult(null);
                setStep("day_list");
              }}
            >
              別の注文を印字
            </s-button>
          </s-stack>
        </s-box>
      </s-page>
    );
  }

  return (
    <s-page heading="販売レシート印字">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text fontWeight="bold">{selectedOrder?.orderName || "注文"}</s-text>
            <s-text tone="subdued">
              {gift ? "ギフト用に注文番号・品名・数量を印刷します。" : "販売レシートでは設定に応じて金額・注文属性・商品属性を印刷します。"}
            </s-text>
            <s-button disabled={loading} onClick={() => {
              setGift(!gift);
              setPrintResult(null);
              setError("");
            }}>
              {gift ? "通常の販売レシートに切り替え" : "金額なしのギフトレシートに切り替え"}
            </s-button>
            {error ? <s-banner tone="critical" heading={error} /> : null}
            <s-button variant="primary" onClick={() => handlePrint(false)} disabled={loading}>
              {loading ? "印字中…" : `${gift ? "ギフト" : "販売"}レシートをプリンタへ送信`}
            </s-button>
            {printResult?.canUseDialog ? (
              <s-button onClick={() => handlePrint(true)} disabled={loading}>
                システム印刷ダイアログを開く
              </s-button>
            ) : null}
            <s-button
              onClick={() => {
                setSelectedOrder(null);
                setError("");
                setStep("day_list");
              }}
            >
              戻る
            </s-button>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
