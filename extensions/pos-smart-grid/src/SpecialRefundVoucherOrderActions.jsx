/**
 * 取引詳細のメニュー: 特殊返金・商品券調整
 * Shopify CLI は同一拡張内で同じ target を複数定義できないため、1モジュールにまとめる。
 */
import { render } from "preact";

const STORAGE_KEY_SPECIAL_REFUND = "pos_special_refund_order_id";
const STORAGE_KEY_VOUCHER = "pos_voucher_adjustment_order_id";

export default async () => {
  render(<SpecialRefundVoucherOrderActions />, document.body);
};

function SpecialRefundVoucherOrderActions() {
  const persistOrderId = (storageKey) => {
    try {
      const orderId = shopify?.order?.id;
      if (orderId != null) {
        sessionStorage.setItem(storageKey, String(orderId));
      }
    } catch (e) {
      console.error("[SpecialRefundVoucherOrderActions] persist", e);
    }
  };

  const onSpecialRefund = () => {
    try {
      persistOrderId(STORAGE_KEY_SPECIAL_REFUND);
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[SpecialRefundVoucherOrderActions] special refund", e);
      shopify?.action?.presentModal?.();
    }
  };

  const onVoucher = () => {
    try {
      persistOrderId(STORAGE_KEY_VOUCHER);
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[SpecialRefundVoucherOrderActions] voucher", e);
      shopify?.action?.presentModal?.();
    }
  };

  return (
    <s-stack gap="small">
      <s-button onClick={onSpecialRefund}>特殊返金調整</s-button>
      <s-button onClick={onVoucher}>商品券釣銭調整</s-button>
    </s-stack>
  );
}
