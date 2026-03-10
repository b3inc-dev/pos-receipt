/**
 * 領収書タイル
 * Phase 5 で実装予定
 */
import { render } from "preact";

export default async () => {
  render(<ReceiptTile />, document.body);
};

function ReceiptTile() {
  return (
    <s-tile
      heading="領収書"
      subheading="領収書発行・再発行"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
