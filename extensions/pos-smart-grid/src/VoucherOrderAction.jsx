/**
 * 取引詳細メニュー: 商品券釣銭調整（1ボタン＝1メニュー行）
 * モーダルは同一パッケージの SpecialRefundModal（pos.home.modal.render）を共有
 */
import { render } from "preact";

const STORAGE_KEY = "pos_voucher_adjustment_order_id";

export default async () => {
  render(<VoucherOrderAction />, document.body);
};

function VoucherOrderAction() {
  const onClick = () => {
    try {
      const orderId = shopify?.order?.id;
      if (orderId != null) {
        sessionStorage.setItem(STORAGE_KEY, String(orderId));
      }
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[VoucherOrderAction]", e);
      shopify?.action?.presentModal?.();
    }
  };

  return <s-button onClick={onClick}>商品券釣銭調整</s-button>;
}
