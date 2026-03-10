/**
 * 売上サマリータイル
 * Phase 7 で実装予定
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
