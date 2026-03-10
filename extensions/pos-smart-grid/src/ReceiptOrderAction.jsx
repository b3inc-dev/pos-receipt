/**
 * 取引詳細画面「領収書を発行」アクション
 * Phase 5 で実装予定
 */
import { render } from "preact";

const STORAGE_KEY = "pos_receipt_order_id";

export default async () => {
  render(<ReceiptOrderAction />, document.body);
};

function ReceiptOrderAction() {
  const onClick = () => {
    try {
      const orderId = shopify?.order?.id;
      if (orderId != null) {
        sessionStorage.setItem(STORAGE_KEY, String(orderId));
      }
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[ReceiptOrderAction]", e);
      shopify?.action?.presentModal?.();
    }
  };

  return <s-button onClick={onClick}>領収書を発行</s-button>;
}
