/**
 * /app/plan — プラン・課金管理ページ（POS Stock / location-stock-indicator と同様のフラット構造）
 * 要件書 §3 / §Epic G
 *
 * 「アップグレード」ボタン → action → Shopify 課金承認 URL へリダイレクト
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useFetcher, useLocation, useNavigate } from "react-router";
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
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  isInhouseMode,
  planLabel,
  getFullAccess,
  PLAN_FEATURES,
  BILLING_PLANS,
} from "../utils/planFeatures.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const SUBSCRIPTION_QUERY = `#graphql
  query CurrentSubscription {
    currentAppInstallation {
      activeSubscriptions {
        id name status currentPeriodEnd trialDays
      }
    }
  }
`;

const APP_SUBSCRIPTION_CREATE = `#graphql
  mutation AppSubscriptionCreate(
    $name: String!
    $returnUrl: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $test: Boolean
  ) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: $test) {
      userErrors { field message }
      confirmationUrl
      appSubscription { id status }
    }
  }
`;

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const fullAccess = await getFullAccess(admin, session);

  let activeSubscriptions: { id: string; name: string; status: string; currentPeriodEnd: string }[] = [];
  if (!fullAccess) {
    try {
      const res = await admin.graphql(SUBSCRIPTION_QUERY);
      const json = await res.json() as {
        data?: {
          currentAppInstallation?: { activeSubscriptions?: typeof activeSubscriptions };
        };
      };
      activeSubscriptions = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
    } catch {}
  }

  return {
    planCode: shop.planCode ?? "standard",
    planLabel: fullAccess
      ? (isInhouseMode() ? "自社用（無制限）" : "全機能利用可能")
      : planLabel(shop.planCode),
    isInhouse: fullAccess,
    activeSubscriptions,
    standardPlan: BILLING_PLANS.standard,
    proPlan: BILLING_PLANS.pro,
    standardFeatures: PLAN_FEATURES.standard,
    proFeatures: PLAN_FEATURES.pro,
  };
}

// ── Action（サブスクリプション作成 → confirmationUrl へリダイレクト） ──────────

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  if (isInhouseMode()) {
    return { ok: false, error: "自社用モードでは課金不要です" };
  }

  const formData = await request.formData();
  const planKey = formData.get("plan") === "pro" ? "pro" : "standard";
  const planConfig = BILLING_PLANS[planKey];

  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const returnUrl = `${appUrl}/app/plan/callback?plan=${planKey}&shop=${session.shop}`;

  const res = await admin.graphql(APP_SUBSCRIPTION_CREATE, {
    variables: {
      name: planConfig.name,
      returnUrl,
      test: process.env.NODE_ENV !== "production",
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: planConfig.amount, currencyCode: planConfig.currencyCode },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
    },
  });

  const json = await res.json() as {
    data?: {
      appSubscriptionCreate?: {
        confirmationUrl?: string;
        userErrors?: { field: string; message: string }[];
      };
    };
  };

  const result = json.data?.appSubscriptionCreate;
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors[0].message };
  }

  const confirmationUrl = result?.confirmationUrl;
  if (!confirmationUrl) {
    return { ok: false, error: "課金URLの取得に失敗しました" };
  }

  // planCode を仮更新
  await prisma.shop.update({
    where: { id: shop.id },
    data: { planCode: planKey },
  });

  // Shopify の課金承認ページへリダイレクト
  return redirect(confirmationUrl);
}

// ── Page Component ────────────────────────────────────────────────────────────

export default function PlanPage() {
  const {
    planCode,
    planLabel: label,
    isInhouse,
    activeSubscriptions,
    standardPlan,
    proPlan,
    standardFeatures,
    proFeatures,
  } = useLoaderData<typeof loader>();

  const fetcher = useFetcher<typeof action>();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const isPro = isInhouse || planCode === "pro" || planCode === "unlimited";
  const actionError = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <PolarisPageWrapper>
    <Page title="プラン・課金" backAction={{ content: "戻る", onAction: () => navigate("/app" + q) }}>
      <Layout>
        {/* エラー */}
        {actionError && (
          <Layout.Section>
            <Banner tone="critical">{actionError}</Banner>
          </Layout.Section>
        )}

        {/* ── 現在のプラン ── */}
        <Layout.AnnotatedSection
          title="現在のプラン"
          description="ご契約中のプランと次回更新日を確認できます。"
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">プラン</Text>
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

              {!isInhouse && activeSubscriptions.length === 0 && (
                <Text tone="subdued" as="p">有効なサブスクリプションがありません。</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── プラン比較 ── */}
        <Layout.AnnotatedSection
          title="プラン比較"
          description="スタンダードとプロの機能・料金を比較できます。アップグレード後は Shopify の課金承認ページに遷移します。"
        >
          <BlockStack gap="400">
            {/* スタンダード */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h2">スタンダード</Text>
                  {!isPro && <Badge tone="info">現在のプラン</Badge>}
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
              </BlockStack>
            </Card>

            {/* プロ */}
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
                    <fetcher.Form method="post">
                      <input type="hidden" name="plan" value="pro" />
                      <Button
                        variant="primary"
                        submit
                        loading={fetcher.state === "submitting"}
                      >
                        プロプランにアップグレード
                      </Button>
                    </fetcher.Form>
                  </Box>
                )}
                {!isInhouse && isPro && (
                  <Box paddingBlockStart="200">
                    <Text tone="subdued" as="p">現在ご利用中のプランです。</Text>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
    </PolarisPageWrapper>
  );
}
