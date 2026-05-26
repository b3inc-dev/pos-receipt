/**
 * 取引詳細メニュー: 特殊返金調整（1ボタン＝1メニュー行）
 */
import { render } from "preact";

const STORAGE_KEY = "pos_special_refund_order_id";

export default async () => {
  render(<SpecialRefundOrderAction />, document.body);
};

function SpecialRefundOrderAction() {
  const onClick = () => {
    try {
      const orderId = shopify?.order?.id;
      if (orderId != null) {
        sessionStorage.setItem(STORAGE_KEY, String(orderId));
      }
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[SpecialRefundOrderAction]", e);
      shopify?.action?.presentModal?.();
    }
  };

  return <s-button onClick={onClick}>特殊返金調整</s-button>;
}
