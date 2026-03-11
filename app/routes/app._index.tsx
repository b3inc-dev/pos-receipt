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
  Banner,
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
    <Page title="POS Receipt">
      <Layout>
        {/* ── 現在のプラン ── */}
        <Layout.AnnotatedSection
          title="現在のプラン"
          description="ご契約中のプランと利用可能な機能を確認できます。"
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">プラン</Text>
                <Badge tone={isPro ? "success" : "info"}>{label}</Badge>
              </InlineStack>
              <Text tone="subdued" as="p">
                精算・特殊返金・領収書などは POS アプリのタイルから利用できます。
              </Text>
              {!isInhouse && !isPro && (
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p">
                      プロプランにアップグレードすると売上サマリー・予算管理・入店数報告が利用できます。
                    </Text>
                    <Button url="/app/settings/billing" variant="primary">
                      プロプランにアップグレード
                    </Button>
                  </BlockStack>
                </Banner>
              )}
              {(isInhouse || isPro) && (
                <Text tone="subdued" as="p">全機能が利用可能です。</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── 領収書テンプレート ── */}
        <Layout.AnnotatedSection
          title="領収書テンプレート"
          description="発行者情報（会社名・住所・電話番号）や但し書きのデフォルト値を設定します。"
        >
          <Card>
            <BlockStack gap="200">
              <Text tone="subdued" as="p">
                発行者情報・但し書き・印字設定を編集します。
              </Text>
              <Button url="/app/receipt-template">テンプレート設定を開く</Button>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── ロケーション・プラン設定 ── */}
        <Layout.AnnotatedSection
          title="ロケーション設定"
          description="各店舗の印字方式や売上サマリー・入店数報告の有効化を設定します。"
        >
          <Card>
            <BlockStack gap="200">
              <Text tone="subdued" as="p">
                印字方式・売上サマリー有効化を店舗ごとに設定します。
              </Text>
              <InlineStack gap="200">
                <Button url="/app/settings">設定を開く</Button>
                {!isInhouse && (
                  <Button url="/app/settings/billing" variant={isPro ? "plain" : "primary"}>
                    {isPro ? "プラン詳細" : "プロプランへ"}
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── システム診断 ── */}
        <Layout.AnnotatedSection
          title="システム診断"
          description="DB接続・テーブル件数・環境変数の設定状態を確認できます。障害調査や設定確認にご利用ください。"
        >
          <Card>
            <BlockStack gap="200">
              <Text tone="subdued" as="p">
                接続中のショップ情報・直近アクティビティ・必須環境変数の設定状態を一覧で確認できます。
              </Text>
              <Button url="/app/diagnostics">診断ページを開く</Button>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}
