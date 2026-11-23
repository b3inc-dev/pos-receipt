/**
 * 「商品券釣銭登録」の行（取引詳細のメニュー・会計が終わった画面の「管理」。1ボタン＝1行）
 * モーダルは同じパッケージの VoucherModal → SpecialRefundModal を共有
 *
 * T のカード 2026-11-24「釣有りの会計だけ押せる」:
 * - 注文を読んで、商品券釣有りでない会計では押せなくする（行を消せるかは未確認なので、押せないボタンで出す）
 * - 読んでいる間も押せない。読めなかったときは押せるままにして、開いた画面で判定する
 * - 登録済みのときは、開いた画面で調整履歴を出す（SpecialRefundModal.jsx）
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getOrder } from "../../common/orderPickerApi.js";
import { isVoucherAdjustableOrder } from "../../common/voucherAdjustable.js";

const STORAGE_KEY = "pos_voucher_adjustment_order_id";

export default async () => {
  render(<VoucherOrderAction />, document.body);
};

function currentOrderId() {
  try {
    return shopify?.order?.id ?? null;
  } catch (_) {
    return null;
  }
}

function VoucherOrderAction() {
  // "checking" 読んでいる / "ok" 押せる / "not_voucher" 釣有りでない
  const [state, setState] = useState(() => (currentOrderId() != null ? "checking" : "ok"));

  useEffect(() => {
    const orderId = currentOrderId();
    if (orderId == null) return;
    let alive = true;
    getOrder(orderId)
      .then((order) => {
        if (alive) setState(isVoucherAdjustableOrder(order) ? "ok" : "not_voucher");
      })
      .catch((e) => {
        console.warn("[VoucherOrderAction] getOrder", e);
        if (alive) setState("ok");
      });
    return () => {
      alive = false;
    };
  }, []);

  const onClick = () => {
    try {
      const orderId = currentOrderId();
      if (orderId != null) {
        sessionStorage.setItem(STORAGE_KEY, String(orderId));
      }
      shopify?.action?.presentModal?.();
    } catch (e) {
      console.error("[VoucherOrderAction]", e);
      shopify?.action?.presentModal?.();
    }
  };

  return (
    <s-button onClick={onClick} disabled={state !== "ok"}>
      商品券釣銭登録
    </s-button>
  );
}
