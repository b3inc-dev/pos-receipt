/**
 * 返金タイル（返金方法変更）。商品券は「商品券」タイル（VoucherTile.jsx）に分けた（T の決定 2026-11-23）
 */
import { render } from "preact";

export default async () => {
  render(<SpecialRefundTile />, document.body);
};

function SpecialRefundTile() {
  return (
    <s-tile
      heading="返金"
      subheading="返金方法変更"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
