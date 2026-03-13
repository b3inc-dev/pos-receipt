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
  EXTRA_LOCATION_PRICE_USD,
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

  const planCode = shop.planCode === "standard" ? "lite" : (shop.planCode ?? "lite");
  return {
    planCode,
    planLabel: fullAccess
      ? (isInhouseMode() ? "自社用（無制限）" : "全機能利用可能")
      : planLabel(shop.planCode ?? planCode),
    isInhouse: fullAccess,
    activeSubscriptions,
    litePlan: BILLING_PLANS.lite,
    proPlan: BILLING_PLANS.pro,
    liteFeatures: PLAN_FEATURES.lite,
    proFeatures: PLAN_FEATURES.pro,
    extraLocationPriceUsd: EXTRA_LOCATION_PRICE_USD,
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
  const planKey = formData.get("plan") === "pro" ? "pro" : "lite";
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
              price: { amount: String(planConfig.amount), currencyCode: planConfig.currencyCode },
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
    litePlan,
    proPlan,
    liteFeatures,
    proFeatures,
    extraLocationPriceUsd,
  } = useLoaderData<typeof loader>();

  const fetcher = useFetcher<typeof action>();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const isPro = isInhouse || planCode === "pro" || planCode === "unlimited";
  const isLite = planCode === "lite" || planCode === "standard";
  const actionError = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <PolarisPageWrapper>
    <Page title="料金プラン" backAction={{ content: "戻る", onAction: () => navigate("/app" + q) }}>
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
                <Text tone="subdued" as="p">有効なサブスクリプションがありません。下記からプランを選択してください。</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── 料金プラン（POS Stock 風：Lite / Pro カード＋11ロケーション以降の注釈） ── */}
        <Layout.AnnotatedSection
          title="料金プラン"
          description="Lite は3ロケーションまで、Pro は10ロケーションまで。11ロケーション以降は1ロケーションあたりの追加料金がかかります。"
        >
          <BlockStack gap="400">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "16px" }}>
              <PlanCard
                planKey="lite"
                name={litePlan.name}
                priceSummary={`$${litePlan.amount}/月`}
                priceDetail={`${litePlan.priceNote}（$${litePlan.amount}）`}
                summary={liteFeatures.map((f) => f.label).join("・")}
                features={liteFeatures}
                isCurrent={!isInhouse && isLite}
                isInhouse={isInhouse}
                fetcher={fetcher}
              />
              <PlanCard
                planKey="pro"
                name={proPlan.name}
                priceSummary={`$${proPlan.amount}/月`}
                priceDetail={`${proPlan.priceNote}（$${proPlan.amount}）`}
                summary="全機能（売上サマリー・入店数報告・予算管理 含む）"
                features={proFeatures}
                isCurrent={!isInhouse && isPro}
                isInhouse={isInhouse}
                fetcher={fetcher}
              />
            </div>
            <Box paddingBlockStart="200">
              <Text as="p" tone="subdued">
                11ロケーション以降は1ロケーションあたり <strong>${extraLocationPriceUsd}</strong>/月 の追加料金がかかります。
              </Text>
            </Box>
          </BlockStack>
        </Layout.AnnotatedSection>

        {/* ── Lite で利用可能な機能 ── */}
        <Layout.Section>
          <BlockStack gap="300">
            <Text variant="headingMd" as="h2">Lite プランで利用可能な機能</Text>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "12px" }}>
              {liteFeatures.map((f) => (
                <FeatureCard key={f.key} title={f.label} />
              ))}
            </div>
          </BlockStack>
        </Layout.Section>

        {/* ── Pro で利用可能な機能 ── */}
        <Layout.Section>
          <BlockStack gap="300">
            <InlineStack align="center" gap="200">
              <Text variant="headingMd" as="h2">Pro プランで利用可能な機能</Text>
              <Badge tone="info">Pro</Badge>
            </InlineStack>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "12px" }}>
              {proFeatures.map((f) => (
                <FeatureCard key={f.key} title={f.label} pro />
              ))}
            </div>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
    </PolarisPageWrapper>
  );
}

// ── サブコンポーネント（POS Stock の PlanCard / FeatureCard 風） ─────────────────────

function PlanCard({
  planKey,
  name,
  priceSummary,
  priceDetail,
  summary,
  features,
  isCurrent,
  isInhouse,
  fetcher,
}: {
  planKey: "lite" | "pro";
  name: string;
  priceSummary: string;
  priceDetail: string;
  summary: string;
  features: { key: string; label: string }[];
  isCurrent: boolean;
  isInhouse: boolean;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingMd" as="h2">{name}</Text>
          {isCurrent && <Badge tone="info">現在のプラン</Badge>}
        </InlineStack>
        <Text variant="headingLg" as="p">{priceSummary}</Text>
        <Text as="p" tone="subdued" variant="bodySm">{priceDetail}</Text>
        <Text as="p" tone="subdued" variant="bodySm">{summary}</Text>
        <Divider />
        <List type="bullet">
          {features.map((f) => (
            <List.Item key={f.key}>{f.label}</List.Item>
          ))}
        </List>
        {!isInhouse && (
          isCurrent ? (
            <Text as="p" tone="subdued">このプランを利用中です。</Text>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="plan" value={planKey} />
              <Button variant="primary" submit loading={fetcher.state === "submitting"}>
                {planKey === "pro" ? "Proプランにアップグレード" : "このプランを選択する"}
              </Button>
            </fetcher.Form>
          )
        )}
      </BlockStack>
    </Card>
  );
}

function FeatureCard({
  title,
  description,
  pro,
}: {
  title: string;
  description?: string;
  pro?: boolean;
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="center" gap="200">
          <Text variant="headingSm" as="h3">{title}</Text>
          {pro && <Badge tone="info">Pro</Badge>}
        </InlineStack>
        {description ? <Text as="p" tone="subdued" variant="bodySm">{description}</Text> : null}
      </BlockStack>
    </Card>
  );
}
