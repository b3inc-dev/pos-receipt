/**
 * システムグループ共通ナビ: 日常タブ + 高度な設定 Accordion
 */
import { Card } from "@shopify/polaris";
import { TabGroupBar, buildSystemTabs } from "./TabGroupBar";
import { SystemAdvancedNav } from "./SystemAdvancedNav";

export function SystemPageNav({ memberCardEnabled }: { memberCardEnabled: boolean }) {
  return (
    <>
      <Card padding="0">
        <TabGroupBar tabs={buildSystemTabs(memberCardEnabled)} />
      </Card>
      <SystemAdvancedNav />
    </>
  );
}
