/**
 * 売上サマリータイル
 * 要件書 §7, §19.2
 */
import { render } from "preact";

export default async () => {
  render(<SalesSummaryTile />, document.body);
};

function SalesSummaryTile() {
  return (
    <s-tile
      heading="売上サマリー"
      subheading="予算・実績確認"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
