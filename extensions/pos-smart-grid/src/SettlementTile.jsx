/**
 * 精算タイル
 * 要件書 §2, §19.1
 */
import { render } from "preact";

export default async () => {
  render(<SettlementTile />, document.body);
};

function SettlementTile() {
  return (
    <s-tile
      heading="精算"
      subheading="精算・点検"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
