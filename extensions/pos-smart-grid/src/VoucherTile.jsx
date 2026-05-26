/**
 * 商品券釣銭調整タイル（POS ホーム）
 * 取引詳細メニューと同じ拡張に home.tile が必要（領収書・特殊返金と同じ構成）
 */
import { render } from "preact";

export default async () => {
  render(<VoucherTile />, document.body);
};

function VoucherTile() {
  return (
    <s-tile
      heading="商品券"
      subheading="釣銭調整"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
