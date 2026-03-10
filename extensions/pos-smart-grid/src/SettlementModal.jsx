/**
 * 精算モーダル
 * Phase 6 で実装予定
 */
import { render } from "preact";

export default async () => {
  render(<SettlementModal />, document.body);
};

function SettlementModal() {
  return (
    <s-page heading="精算">
      <s-box padding="base">
        <s-text tone="subdued">精算機能は近日実装予定です。</s-text>
      </s-box>
    </s-page>
  );
}
