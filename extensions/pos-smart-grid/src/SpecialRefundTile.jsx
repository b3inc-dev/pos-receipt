/**
 * 特殊返金・商品券調整タイル
 */
import { render } from "preact";

export default async () => {
  render(<SpecialRefundTile />, document.body);
};

function SpecialRefundTile() {
  return (
    <s-tile
      heading="特殊返金・商品券調整"
      subheading="返金手段変更・商品券差額後処理"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
