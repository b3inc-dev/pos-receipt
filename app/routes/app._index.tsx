/**
 * /app — 管理画面トップ
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { planLabel, isInhouseMode } from "../utils/planFeatures.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  return {
    planCode: shop.planCode ?? "standard",
    planLabel: planLabel(shop.planCode),
    isInhouse: isInhouseMode(),
  };
}

export default function AppIndex() {
  const { planCode, planLabel: label, isInhouse } = useLoaderData<typeof loader>();
  const isPro = isInhouse || planCode === "pro" || planCode === "unlimited";

  return (
    <Page title="POS Receipt 管理画面">
      <Layout>
        {/* プラン状態 */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">現在のプラン</Text>
                <Badge tone={isPro ? "success" : "info"}>{label}</Badge>
              </InlineStack>
              <Text tone="subdued" as="p">
                精算・特殊返金・領収書などは POS アプリのタイルから利用できます。
              </Text>
              <InlineStack gap="300">
                <Button url="/app/settings">設定</Button>
                {!isInhouse && !isPro && (
                  <Button url="/app/settings/billing" variant="primary">
                    プロプランにアップグレード
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* クイックリンク */}
        <Layout.Section>
          <Layout>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="200">
                  <Text variant="headingSm" as="h3">領収書テンプレート</Text>
                  <Text tone="subdued" as="p">発行者情報・但し書き・印字設定を編集します。</Text>
                  <Button url="/app/receipt-template">テンプレート設定</Button>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="200">
                  <Text variant="headingSm" as="h3">ロケーション設定</Text>
                  <Text tone="subdued" as="p">印字方式・売上サマリー有効化を店舗ごとに設定します。</Text>
                  <Button url="/app/settings">設定を開く</Button>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="200">
                  <Text variant="headingSm" as="h3">プラン管理</Text>
                  <Text tone="subdued" as="p">
                    {isPro
                      ? "プロプランをご利用中です。全機能が利用可能です。"
                      : "スタンダードプランをご利用中です。プロプランでさらに多くの機能が使えます。"}
                  </Text>
                  <Button url="/app/settings/billing">プラン詳細</Button>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
