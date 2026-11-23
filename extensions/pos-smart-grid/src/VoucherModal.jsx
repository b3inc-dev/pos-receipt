/**
 * 「商品券」タイルのモーダル。特殊返金と同じ画面を、一覧の最初の絞り込みを「商品券釣有り」にして開く。
 * （「返金・商品券」タイルは SpecialRefundModal.jsx の既定で「返金・キャンセル」）
 */
import { render } from "preact";
import { SpecialRefundModal } from "./SpecialRefundModal.jsx";

export default async () => {
  render(<SpecialRefundModal initialListSegment="voucher_change" />, document.body);
};
