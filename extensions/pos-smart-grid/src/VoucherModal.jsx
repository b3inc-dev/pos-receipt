/**
 * 「商品券」タイルのモーダル。
 * - カートに商品があるとき: 会計の前に商品券の額面を入れる画面（VoucherCartScreen）を先に出す
 * - カートが空・取引詳細の「商品券釣銭調整」から開いたとき: 後から登録する一覧
 *   （特殊返金と同じ画面を、一覧の最初の絞り込みを「商品券釣有り」にして開く）
 * （「返金」タイルは SpecialRefundModal.jsx の既定で「返金・キャンセル」）
 */
import { render } from "preact";
import { useState } from "preact/hooks";
import { SpecialRefundModal } from "./SpecialRefundModal.jsx";
import { VoucherCartScreen } from "./VoucherCartScreen.jsx";

/** 取引詳細の「商品券釣銭調整」が入れる目印（VoucherOrderAction.jsx と同じ） */
const STORAGE_KEY_VOUCHER_ORDER = "pos_voucher_adjustment_order_id";

export default async () => {
  render(<VoucherModal />, document.body);
};

function openedFromOrderDetails() {
  try {
    return Boolean(sessionStorage.getItem(STORAGE_KEY_VOUCHER_ORDER));
  } catch (_) {
    return false;
  }
}

function cartHasItems() {
  try {
    const cart = globalThis?.shopify?.cart?.current?.value;
    return Array.isArray(cart?.lineItems) && cart.lineItems.length > 0;
  } catch (_) {
    return false;
  }
}

function VoucherModal() {
  const [screen, setScreen] = useState(() =>
    !openedFromOrderDetails() && cartHasItems() ? "cart" : "list",
  );
  if (screen === "cart") {
    return <VoucherCartScreen onOpenList={() => setScreen("list")} />;
  }
  return <SpecialRefundModal initialListSegment="voucher_change" />;
}
