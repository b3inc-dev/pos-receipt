/**
 * 取引詳細画面のアクションメニュー「この取引で開く」
 * クリックでモーダルを開き、現在の注文を渡す
 */
import { render } from "preact";

const STORAGE_KEY = "pos_receipt_pre_selected_order_id";

export default async () => {
  render(<OrderActionButton />, document.body);
};

function OrderActionButton() {
  const onClick = () => {
    try {
      const orderId = shopify?.order?.id;
      if (orderId != null) {
        sessionStorage.setItem(STORAGE_KEY, String(orderId));
      }
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[OrderAction]", e);
      shopify?.action?.presentModal?.();
    }
  };

  return (
    <s-button onClick={onClick}>
      この取引で開く
    </s-button>
  );
}
