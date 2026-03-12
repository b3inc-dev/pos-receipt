/**
 * 領収書タイル
 * 要件書 §8, §19.2
 */
import { render } from "preact";

export default async () => {
  render(<ReceiptTile />, document.body);
};

function ReceiptTile() {
  return (
    <s-tile
      heading="領収書"
      subheading="領収書発行・履歴"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
