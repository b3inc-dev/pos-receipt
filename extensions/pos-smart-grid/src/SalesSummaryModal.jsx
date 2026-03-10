/**
 * 売上サマリーモーダル
 * Phase 7 で実装予定
 */
import { render } from "preact";

export default async () => {
  render(<SalesSummaryModal />, document.body);
};

function SalesSummaryModal() {
  return (
    <s-page heading="売上サマリー">
      <s-box padding="base">
        <s-text tone="subdued">売上サマリー機能は近日実装予定です。</s-text>
      </s-box>
    </s-page>
  );
}
