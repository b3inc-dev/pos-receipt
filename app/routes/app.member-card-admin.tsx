/**
 * 会員証（LIFF）設定・説明の管理画面。
 * LIFF ID と App Proxy の設定状態を確認し、LINE 側の設定手順を案内する。
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { Page, Layout, Card, Text, BlockStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { MemberBarcode } from "../components/MemberBarcode";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  const shop = new URL(request.url).searchParams.get("shop") ?? "";
  const liffIdSet = Boolean(process.env.LIFF_ID?.trim());
  const apiBaseSet = Boolean(process.env.SHOPIFY_APP_URL?.trim());
  const lineChannelSet =
    Boolean(process.env.LINE_CHANNEL_ID?.trim()) &&
    Boolean(process.env.LINE_CHANNEL_SECRET?.trim());

  const proxyPath = "apps/member-card";
  const proxyUrl = shop ? `https://${shop}/${proxyPath}` : "";

  return {
    shop,
    liffIdSet,
    apiBaseSet,
    lineChannelSet,
    proxyPath,
    proxyUrl,
  };
}

export default function MemberCardAdminPage() {
  const data = useLoaderData<typeof loader>();

  return (
    <PolarisPageWrapper>
      <Page title="会員証（LIFF）" backAction={{ content: "戻る", url: "/app" }}>
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  設定状態
                </Text>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    <strong>LIFF ID:</strong>{" "}
                    {data.liffIdSet ? "設定済み" : "未設定"}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    <strong>LINE チャネル（ID / Secret）:</strong>{" "}
                    {data.lineChannelSet ? "設定済み" : "未設定"}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    <strong>アプリ URL（SHOPIFY_APP_URL）:</strong>{" "}
                    {data.apiBaseSet ? "設定済み" : "未設定"}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    <strong>App Proxy パス:</strong> {data.proxyPath}
                  </Text>
                  {data.proxyUrl && (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      会員証の公開URL: {data.proxyUrl}
                    </Text>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  LIFF 側の設定
                </Text>
                <Text as="p" variant="bodyMd">
                  LINE Developers の LIFF アプリで「Endpoint URL」に上記の会員証の公開URL（
                  {data.proxyUrl || "https://あなたのショップ.myshopify.com/apps/member-card"}
                  ）を設定してください。
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  LINE リッチメニューからこの LIFF を開くと、LINE ログイン後に会員バーコードが表示されます。CRM PLUS on LINE で連携済みの顧客（socialplus.line）と会員番号（membership.id）が紐づいている必要があります。
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  バーコード表示サンプル（CODE128）
                </Text>
                <div style={{ textAlign: "center", padding: "16px 0" }}>
                  <MemberBarcode value="12345678" />
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
