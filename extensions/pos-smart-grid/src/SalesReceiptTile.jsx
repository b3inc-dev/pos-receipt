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
      subheading="属性付き印字"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
