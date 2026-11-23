/**
 * 「商品券釣銭登録」タイルのモーダル。
 * - カートに商品があり、管理画面の「会計の前に額面を入れる」がオンのとき: 会計の前に額面を入れる画面（VoucherCartScreen）を先に出す
 * - カートが空・取引詳細の「商品券釣銭登録」から開いたとき: 後から登録する一覧
 *   （特殊返金と同じ画面を、一覧の最初の絞り込みを「商品券釣有り」にして開く）
 * （「返金方法変更」タイルは SpecialRefundModal.jsx の既定で「返金・キャンセル」）
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getVoucherCartEntryEnabled } from "../../common/specialRefundApi.js";
import { SpecialRefundModal } from "./SpecialRefundModal.jsx";
import { VoucherCartScreen } from "./VoucherCartScreen.jsx";

/** 取引詳細の「商品券釣銭登録」が入れる目印（VoucherOrderAction.jsx と同じ） */
const STORAGE_KEY_VOUCHER_ORDER = "pos_voucher_adjustment_order_id";

export default async () => {
  render(<VoucherModal />, document.body);
};

function openedFromOrderDetails() {
  // 会計が終わった画面の「管理」の行（pos.purchase.post.action.render）は、POS が行を描いて押すとそのままこの画面を開く。
  // 行の onClick が呼ばれず目印が入らないので、この画面が受け取る注文（Order API）を目印にする（T の実機 2026-11-24）
  try {
    const orderId = globalThis?.shopify?.order?.id;
    if (orderId != null && orderId !== "") {
      sessionStorage.setItem(STORAGE_KEY_VOUCHER_ORDER, String(orderId));
      return true;
    }
  } catch (_) {
    /* ホームのタイルには注文が無い */
  }
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
  // カートに商品があるときだけ、管理画面の「会計の前に額面を入れる」（初めはオフ）を確かめてから決める
  // 取引詳細から開いたか（一覧の画面が目印を消すので、最初に一度だけ読む）
  const [fromOrder] = useState(() => openedFromOrderDetails());
  const [screen, setScreen] = useState(() => (!fromOrder && cartHasItems() ? "checking" : "list"));
  const [listNote, setListNote] = useState("");
  // カートに商品がある: 「会計の前に額面を入れる」がオンなら入力の画面へ。使えないときは一覧の上に一行でわけを出す
  useEffect(() => {
    if (screen !== "checking") return;
    let alive = true;
    getVoucherCartEntryEnabled()
      .then((res) => {
        if (!alive) return;
        if (res?.enabled === true) {
          setScreen("cart");
          return;
        }
        setListNote(
          "会計の前に額面を入れる機能がオフです。使うときは、管理画面の「商品券設定」で「商品券機能」「手動調整」「会計の前に額面を入れる」をオンにします。",
        );
        setScreen("list");
      })
      .catch(() => {
        if (!alive) return;
        setListNote("会計の前に額面を入れる設定を読めませんでした。通信を確かめて、タイルを開き直してください。");
        setScreen("list");
      });
    return () => {
      alive = false;
    };
  }, [screen]);
  // カートが空で一覧を出すとき: 先に額面を入れる入口を一覧の上に出す（スイッチがオンの店だけ。T 2026-11-24）
  const [canEnterBeforeItems, setCanEnterBeforeItems] = useState(false);
  useEffect(() => {
    if (screen !== "list" || listNote || fromOrder || cartHasItems()) return;
    let alive = true;
    getVoucherCartEntryEnabled()
      .then((res) => {
        if (alive && res?.enabled === true) setCanEnterBeforeItems(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [screen]);
  if (screen === "checking") {
    return (
      <s-page heading="商品券釣銭登録">
        <s-box padding="base">
          <s-text color="subdued">読み込み中…</s-text>
        </s-box>
      </s-page>
    );
  }
  if (screen === "cart") {
    return <VoucherCartScreen onOpenList={() => setScreen("list")} />;
  }
  return (
    <SpecialRefundModal
      initialListSegment="voucher_change"
      listNote={listNote}
      listAction={
        canEnterBeforeItems ? { label: "会計前登録", onClick: () => setScreen("cart") } : null
      }
    />
  );
}
