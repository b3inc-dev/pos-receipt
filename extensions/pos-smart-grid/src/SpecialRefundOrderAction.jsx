/**
 * 取引詳細画面「特殊返金・商品券調整」アクション
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

  return <s-button onClick={onClick}>特殊返金・商品券調整</s-button>;
}
