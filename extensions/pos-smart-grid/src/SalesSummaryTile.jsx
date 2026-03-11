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
      subheading="売上・予算・KPI確認"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
