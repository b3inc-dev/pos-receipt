/**
 * 領収書モーダル
 * Phase 5 で実装予定
 */
import { render } from "preact";

export default async () => {
  render(<ReceiptModal />, document.body);
};

function ReceiptModal() {
  return (
    <s-page heading="領収書">
      <s-box padding="base">
        <s-text tone="subdued">領収書機能は近日実装予定です。</s-text>
      </s-box>
    </s-page>
  );
}
