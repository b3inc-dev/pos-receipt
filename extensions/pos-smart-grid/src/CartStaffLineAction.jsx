import { render } from "preact";

export default async () => {
  render(<CartStaffLineAction />, document.body);
};

function CartStaffLineAction() {
  return (
    <s-button onClick={() => shopify.action.presentModal()}>
      担当を変更
    </s-button>
  );
}
