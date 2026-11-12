import { render } from "preact";

export default async () => {
  render(<CartStaffTile />, document.body);
};

function CartStaffTile() {
  return (
    <s-tile
      heading="販売担当"
      subheading="一括・明細"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
