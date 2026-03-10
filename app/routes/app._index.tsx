import { Link } from "react-router";
import { Page, Layout, Card, Text } from "@shopify/polaris";

export default function AppIndex() {
  return (
    <Page title="POS Receipt">
      <Layout>
        <Layout.Section>
          <Card>
            <Text as="p" variant="bodyMd">
              精算・領収書・売上サマリーなどは POS アプリのタイルから利用できます。
              設定は今後こちらで行える予定です。
            </Text>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
