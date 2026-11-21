/**
 * システムグループ共通ナビ: 日常タブ + 高度な設定 Accordion
 * memberCardEnabled は app layout loader を正本とし、全 System ページで共用する。
 */
import { Card } from "@shopify/polaris";
import { useRouteLoaderData } from "react-router";
import { TabGroupBar, buildSystemTabs } from "./TabGroupBar";
import { SystemAdvancedNav } from "./SystemAdvancedNav";

type AppLayoutData = { memberCardEnabled?: boolean };

export function SystemPageNav({
  memberCardEnabled,
}: {
  /** 省略時は routes/app layout loader の値を使用 */
  memberCardEnabled?: boolean;
} = {}) {
  const layoutData = useRouteLoaderData("routes/app") as AppLayoutData | undefined;
  const enabled = memberCardEnabled ?? layoutData?.memberCardEnabled ?? false;

  return (
    <>
      <Card padding="0">
        <TabGroupBar tabs={buildSystemTabs(enabled)} />
      </Card>
      <SystemAdvancedNav />
    </>
  );
}
