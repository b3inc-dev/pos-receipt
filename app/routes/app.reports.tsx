import type { LoaderFunctionArgs } from "react-router";
import { useLocation } from "react-router";
import { Page, Card, BlockStack, Text, Button, Layout } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, REPORTS_TABS } from "../components/TabGroupBar";
import { useGuardedNavigate } from "../components/admin-ui";

export async function loader({request}: LoaderFunctionArgs) { await authenticate.admin(request); return {}; }
export default function ReportsPage() {
  const navigate = useGuardedNavigate(); const q = useLocation().search;
  const groups = [
    {title:"売上を見る",description:"日次・月次の実績、予算、入店数を確認します。",links:[["/app/sales-summary","売上サマリー"]]},
    {title:"予算を管理する",description:"店舗・販売チャネルの予算を登録します。",links:[["/app/budget-management","店舗予算"],["/app/channel-budget-management","チャネル予算"]]},
    {title:"集計の設定",description:"表示する指標や販売チャネルを設定します。ここを開いても売上集計は始まりません。",links:[["/app/sales-summary-settings","サマリー設定"],["/app/sales-channels","チャネル管理"],["/app/budget-settings","予算設定"]]},
  ];
  return <PolarisPageWrapper><Page title="レポート" backAction={{content:"ホーム",onAction:()=>navigate("/app"+q)}}>
    <TabGroupBar tabs={REPORTS_TABS}/>
    <Layout>{groups.map(g=><Layout.Section key={g.title}><Card><BlockStack gap="300"><Text as="h2" variant="headingMd">{g.title}</Text><Text as="p" tone="subdued">{g.description}</Text>
      {g.links.map(([path,label])=><Button key={path} onClick={()=>navigate(path+q)}>{label}</Button>)}
    </BlockStack></Card></Layout.Section>)}</Layout>
  </Page></PolarisPageWrapper>;
}
