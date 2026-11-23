/**
 * 特殊返金・商品券釣銭調整タイル
 */
import { render } from "preact";

export default async () => {
  render(<SpecialRefundTile />, document.body);
};

function SpecialRefundTile() {
  return (
    <s-tile
      heading="返金・商品券"
      subheading="特殊返金・商品券釣銭登録"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
