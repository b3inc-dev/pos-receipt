/**
 * 取引詳細画面「商品券調整」アクション
 * モーダルは商品券調整フォームへ直行（戻るで取引明細に戻る）
 */
import { render } from "preact";

const STORAGE_KEY_VOUCHER = "pos_voucher_adjustment_order_id";

export default async () => {
  render(<VoucherOrderAction />, document.body);
};

function VoucherOrderAction() {
  const onClick = () => {
    try {
      const orderId = shopify?.order?.id;
      if (orderId != null) {
        sessionStorage.setItem(STORAGE_KEY_VOUCHER, String(orderId));
      }
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[VoucherOrderAction]", e);
      shopify?.action?.presentModal?.();
    }
  };

  return <s-button onClick={onClick}>商品券調整</s-button>;
}
