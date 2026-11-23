/**
 * 販売レシートタイル
 */
import { render } from "preact";

export default async () => {
  render(<SalesReceiptTile />, document.body);
};

function SalesReceiptTile() {
  return (
    <s-tile
      heading="販売レシート"
      subheading="レシートを印刷する"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
