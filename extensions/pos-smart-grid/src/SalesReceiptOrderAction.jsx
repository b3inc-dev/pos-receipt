/**
 * 取引詳細 / 購入後「販売レシートを印字」
 */
import { render } from "preact";

const STORAGE_KEY = "pos_sales_receipt_order_id";

export default async () => {
  render(<SalesReceiptOrderAction />, document.body);
};

function SalesReceiptOrderAction() {
  const onClick = () => {
    try {
      const orderId = shopify?.order?.id;
      if (orderId != null) {
        sessionStorage.setItem(STORAGE_KEY, String(orderId));
      }
    } catch (e) {
      console.error("[SalesReceiptOrderAction]", e);
    }
    try {
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[SalesReceiptOrderAction] presentModal", e);
    }
  };

  return <s-button onClick={onClick}>販売レシートを印字</s-button>;
}
