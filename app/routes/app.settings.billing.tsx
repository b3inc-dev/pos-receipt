/**
 * /app/settings/billing — プラン・課金管理ページ
 * 要件書 §3 / §Epic G
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
  List,
  Banner,
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  isInhouseMode,
  planLabel,
  PLAN_FEATURES,
  BILLING_PLANS,
} from "../utils/planFeatures.server";

const SUBSCRIPTION_QUERY = `#graphql
  query CurrentSubscription {
    currentAppInstallation {
      activeSubscriptions {
        id name status currentPeriodEnd trialDays
      }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  let activeSubscriptions: { id: string; name: string; status: string; currentPeriodEnd: string }[] = [];
  if (!isInhouseMode()) {
    try {
      const res = await admin.graphql(SUBSCRIPTION_QUERY);
      const json = await res.json() as {
        data?: {
          currentAppInstallation?: {
            activeSubscriptions?: typeof activeSubscriptions;
          };
        };
      };
      activeSubscriptions = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
    } catch {}
  }

  return {
    planCode: shop.planCode ?? "standard",
    planLabel: planLabel(shop.planCode),
    isInhouse: isInhouseMode(),
    activeSubscriptions,
    standardPlan: BILLING_PLANS.standard,
    proPlan: BILLING_PLANS.pro,
    standardFeatures: PLAN_FEATURES.standard,
    proFeatures: PLAN_FEATURES.pro,
  };
}

export default function BillingPage() {
  const { planCode, planLabel: label, isInhouse, activeSubscriptions, standardPlan, proPlan, standardFeatures, proFeatures } =
    useLoaderData<typeof loader>();

  const isPro = isInhouse || planCode === "pro" || planCode === "unlimited";

  return (
    <Page title="プラン・課金" backAction={{ url: "/app/settings" }}>
      <Layout>
        {/* 現在のプラン */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">現在のプラン</Text>
                <Badge tone={isPro ? "success" : "info"}>{label}</Badge>
              </InlineStack>

              {isInhouse && (
                <Text tone="subdued" as="p">自社用モードのため課金は不要です。全機能が利用可能です。</Text>
              )}

              {!isInhouse && activeSubscriptions.length > 0 && (
                <BlockStack gap="100">
                  {activeSubscriptions.map((sub) => (
                    <Text key={sub.id} tone="subdued" as="p">
                      {sub.name}（{sub.status}）- 次回更新: {sub.currentPeriodEnd?.slice(0, 10) ?? "—"}
                    </Text>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* プラン比較 */}
        <Layout.Section>
          <InlineStack gap="400" align="start">
            {/* スタンダード */}
            <Box minWidth="280px">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingMd" as="h2">スタンダード</Text>
                    {!isPro && planCode === "standard" && <Badge tone="info">現在のプラン</Badge>}
                  </InlineStack>
                  <Text variant="headingLg" as="p">
                    ¥{standardPlan.amount.toLocaleString("ja-JP")}
                    <Text as="span" tone="subdued" variant="bodySm"> / 月</Text>
                  </Text>
                  <Divider />
                  <List type="bullet">
                    {standardFeatures.map((f) => (
                      <List.Item key={f.key}>{f.label}</List.Item>
                    ))}
                  </List>
                  {!isPro && planCode === "standard" && (
                    <Box paddingBlockStart="200">
                      <Text tone="subdued" as="p">現在ご利用中のプランです。</Text>
                    </Box>
                  )}
                </BlockStack>
              </Card>
            </Box>

            {/* プロ */}
            <Box minWidth="280px">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingMd" as="h2">プロ</Text>
                    {isPro && !isInhouse && <Badge tone="success">現在のプラン</Badge>}
                  </InlineStack>
                  <Text variant="headingLg" as="p">
                    ¥{proPlan.amount.toLocaleString("ja-JP")}
                    <Text as="span" tone="subdued" variant="bodySm"> / 月</Text>
                  </Text>
                  <Divider />
                  <List type="bullet">
                    {proFeatures.map((f) => (
                      <List.Item key={f.key}>{f.label}</List.Item>
                    ))}
                  </List>
                  {!isInhouse && !isPro && (
                    <Box paddingBlockStart="200">
                      <UpgradeButton plan="pro" />
                    </Box>
                  )}
                  {!isInhouse && isPro && (
                    <Box paddingBlockStart="200">
                      <Text tone="subdued" as="p">現在ご利用中のプランです。</Text>
                    </Box>
                  )}
                </BlockStack>
              </Card>
            </Box>
          </InlineStack>
        </Layout.Section>

        {!isInhouse && !isPro && (
          <Layout.Section>
            <Banner tone="info">
              <Text as="p">
                プロプランにアップグレードすると、売上サマリー・予算管理・入店数報告が利用できます。
                アップグレード後、Shopify の課金承認ページに遷移します。
              </Text>
            </Banner>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}

function UpgradeButton({ plan }: { plan: string }) {
  const handleUpgrade = async () => {
    try {
      const res = await fetch("/api/billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json() as { confirmationUrl?: string };
      if (data.confirmationUrl) {
        window.location.href = data.confirmationUrl;
      }
    } catch (e) {
      alert("アップグレードに失敗しました。再度お試しください。");
    }
  };

  return (
    <Button variant="primary" onClick={handleUpgrade}>
      プロプランにアップグレード
    </Button>
  );
}
