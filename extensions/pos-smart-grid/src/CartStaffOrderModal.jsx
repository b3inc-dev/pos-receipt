import { render } from "preact";
import { useState } from "preact/hooks";
import { OrderStaffCorrection } from "./OrderStaffCorrection.jsx";

const STORAGE_KEY = "pos_cart_staff_order_id";

export default async () => {
  render(<CartStaffOrderModal />, document.body);
};

function readOrderId() {
  try {
    const fromOrder = shopify?.order?.id;
    if (fromOrder != null) return String(fromOrder);
  } catch {
    // 取引履歴から開いたときは保存したIDを使う。
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function CartStaffOrderModal() {
  const [orderId] = useState(readOrderId);
  if (!orderId) {
    return (
      <s-page heading="確定済みの担当">
        <s-box padding="base">
          <s-text>取引を特定できませんでした。</s-text>
        </s-box>
      </s-page>
    );
  }
  return <OrderStaffCorrection orderId={orderId} />;
}
