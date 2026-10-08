/**
 * 販売レシート印字モーダル
 * 注文選択 → プレビュー案内 → shopify.printing
 */
import { render } from "preact";
import { useState, useCallback, useEffect } from "preact/hooks";
import { getOrder } from "../../common/orderPickerApi.js";
import { printSalesReceipt } from "../../common/printApi.js";
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
      setSelectedOrder(order);
      setStep("confirm");
    } catch (e) {
      setError(toUserMessage(e?.message) || "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const handlePrint = useCallback(async () => {
    if (!selectedOrder?.orderId) return;
    setLoading(true);
    setError("");
    try {
      const res = await printSalesReceipt(selectedOrder.orderId);
      setPrintResult(res);
      if (!res.ok) {
        setError(res.error || "印字に失敗しました");
        return;
      }
      setStep("done");
    } catch (e) {
      setError(toUserMessage(e?.message) || "印字に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedOrder]);

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
            <s-text fontWeight="bold">販売レシートを送信しました</s-text>
            <s-text tone="subdued">
              {selectedOrder?.orderName || selectedOrder?.orderId}
            </s-text>
            {printResult?.usedDialog ? (
              <s-text tone="subdued" fontSize="small">
                接続プリンタが見つからなかったため、印刷ダイアログを開きました。
              </s-text>
            ) : null}
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
              注文・商品の属性（ON の場合）を末尾に含めて印刷します。設定は管理画面の「販売レシート」から変更できます。
            </s-text>
            {error ? <s-banner tone="critical" heading={error} /> : null}
            <s-button variant="primary" onClick={handlePrint} disabled={loading}>
              {loading ? "印字中…" : "プリンタへ送信"}
            </s-button>
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
