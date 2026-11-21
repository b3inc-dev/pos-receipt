import { render } from "preact";

const STORAGE_KEY = "pos_cart_staff_order_id";

export default async () => {
  render(<CartStaffOrderAction />, document.body);
};

function CartStaffOrderAction() {
  const onClick = () => {
    try {
      const orderId = shopify?.order?.id;
      if (orderId != null) sessionStorage.setItem(STORAGE_KEY, String(orderId));
    } catch {
      // 注文IDが取れないときは詳細画面で案内する。
    }
    shopify.action.presentModal();
  };

  return <s-button onClick={onClick}>販売担当を確認</s-button>;
}
