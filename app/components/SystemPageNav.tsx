/**
 * システムグループ共通ナビ: 日常タブ + 高度な設定 Accordion
 */
import { Card } from "@shopify/polaris";
import { TabGroupBar, buildSystemTabs } from "./TabGroupBar";
import { SystemAdvancedNav } from "./SystemAdvancedNav";

/**
 * isDevStore: 開発ストアのときだけ true を渡す（「システム診断」へのボタンを出す）。
 * 渡さない画面では出さない（出さない側に倒す）。
 */
export function SystemPageNav({
  memberCardEnabled,
  isDevStore = false,
}: {
  memberCardEnabled: boolean;
  isDevStore?: boolean;
}) {
  return (
    <>
      <Card padding="0">
        <TabGroupBar tabs={buildSystemTabs(memberCardEnabled)} />
      </Card>
      <SystemAdvancedNav showDiagnostics={isDevStore} />
    </>
  );
}
