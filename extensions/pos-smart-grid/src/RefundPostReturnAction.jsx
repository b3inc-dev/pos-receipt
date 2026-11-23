/**
 * 返品・交換が終わった画面の「管理」の行: 返金の手段の変更（その注文の返金の画面を開く。T 2026-11-24）
 */
import { render } from "preact";

const STORAGE_KEY = "pos_special_refund_order_id";

export default async () => {
  render(<RefundPostReturnAction />, document.body);
};

function RefundPostReturnAction() {
  const onClick = () => {
    try {
      const orderId = shopify?.order?.id;
      if (orderId != null) {
        sessionStorage.setItem(STORAGE_KEY, String(orderId));
      }
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[RefundPostReturnAction]", e);
      shopify?.action?.presentModal?.();
    }
  };

  return <s-button onClick={onClick}>返金の手段の変更</s-button>;
}
