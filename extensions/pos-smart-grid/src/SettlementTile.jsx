/**
 * 精算タイル
 * Phase 6 で実装予定
 */
import { render } from "preact";

export default async () => {
  render(<SettlementTile />, document.body);
};

function SettlementTile() {
  return (
    <s-tile
      heading="精算"
      subheading="精算レシート・点検レシート"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
