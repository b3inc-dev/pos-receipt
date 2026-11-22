/**
 * /app/plan — 料金プラン（UI_RULES 2章の形3: カード1列、見出しと説明はカードの中）
 * 要件書 §3 / §Epic G
 *
 * 2026-11-21 T の決定: 公開用の料金は Shopify App Pricing（Billing API ではない）。
 * - アプリは契約を作らない。「プランを選ぶ」は Shopify の料金プラン画面（app handle の pricing_plans）を開くだけ。
 * - 今のプランは契約から読む（shopPlan.server.ts。Admin API、設定があれば Partner API も）。
 * - 自社用（Ciara）は今まで通り課金なし・全機能。
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  InlineGrid,
  List,
  Banner,
  Divider,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { SystemPageNav } from "../components/SystemPageNav";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  isInhouseMode,
  planLabel,
  PLAN_FEATURES,
  BILLING_PLANS,
  EXTRA_LOCATION_PRICE_USD,
  buildPricingPlansUrl,
} from "../utils/planFeatures.server";
import { getShopPlan } from "../utils/shopPlan.server";
import {
  describeUsageReportForMerchant,
  findUsageReportForPeriod,
  isUsageReportingEnabled,
  usagePeriodKey,
  type UsageReportStore,
} from "../utils/appEventsUsage.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const state = await getShopPlan(admin, shop);
  const isInhouse = state.fullAccess;

  // 超えたロケーションの報告の状態（App Events API）。読めなくても画面は出す
  let usageReportNote: string | null = null;
  const usage = state.extraLocationUsage;
  if (usage && isUsageReportingEnabled()) {
    try {
      const periodKey = usagePeriodKey(usage.periodEnd);
      const row = periodKey
        ? await findUsageReportForPeriod(
            prisma.appUsageReport as unknown as UsageReportStore,
            session.shop.trim().toLowerCase(),
            periodKey
          )
        : { status: "missing_period" };
      usageReportNote = describeUsageReportForMerchant(row);
    } catch (e) {
      console.warn("[app.plan] usage report read failed:", e instanceof Error ? e.message : String(e));
      usageReportNote = "報告の状態を読めませんでした。少し待ってから再読み込みしてください。";
    }
  }

  return {
    planCode: state.planCode,
    planLabel: isInhouse
      ? (isInhouseMode() ? "自社用（無制限）" : "全機能利用可能")
      : planLabel(state.planCode),
    isInhouse,
    hasSubscription: state.plan !== null,
    subscriptionsRead: state.subscriptionsRead,
    activeSubscriptions: state.activeSubscriptions,
    locationsCount: state.locationsCount,
    extraLocationUsage: usage ?? null,
    extraLocationStatus: state.extraLocationStatus,
    usageReportingEnabled: isUsageReportingEnabled(),
    usageReportNote,
    pricingPlansUrl: isInhouseMode() ? null : buildPricingPlansUrl(session.shop),
    litePlan: BILLING_PLANS.lite,
    proPlan: BILLING_PLANS.pro,
    liteFeatures: PLAN_FEATURES.lite,
    proFeatures: PLAN_FEATURES.pro,
    extraLocationPriceUsd: EXTRA_LOCATION_PRICE_USD,
    memberCardEnabled: isInhouseMode(),
  };
}

// 2026-11-21: action（appSubscriptionCreate で契約を作って承認 URL へ飛ばす）は消した。
// プランの選択・変更・解約は Shopify の料金プラン画面で行う。

// ── Page Component ────────────────────────────────────────────────────────────

export default function PlanPage() {
  const {
    planCode,
    planLabel: label,
    isInhouse,
    hasSubscription,
    subscriptionsRead,
    activeSubscriptions,
    locationsCount,
    extraLocationUsage,
    extraLocationStatus,
    usageReportingEnabled,
    usageReportNote,
    pricingPlansUrl,
    litePlan,
    proPlan,
    liteFeatures,
    proFeatures,
    extraLocationPriceUsd,
    memberCardEnabled,
  } = useLoaderData<typeof loader>();

  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const isPro = isInhouse || planCode === "pro" || planCode === "unlimited";
  const isLite = !isPro;
  const liteKeys = new Set(liteFeatures.map((f) => f.key as string));
  const proOnlyKeys = new Set(proFeatures.map((f) => f.key as string).filter((k) => !liteKeys.has(k)));
  const openPricingPlans = () => {
    if (pricingPlansUrl) window.open(pricingPlansUrl, "_top");
  };

  // 今のプランのバッジ（5章: 有効は緑、人が見る必要があるものは黄）
  const planBadge = isInhouse || hasSubscription
    ? { tone: "success" as const, text: label }
    : subscriptionsRead
      ? { tone: "attention" as const, text: "未契約" }
      : { tone: "attention" as const, text: "要確認" };

  return (
    <PolarisPageWrapper>
    <Page title="料金プラン" backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}>
      <SystemPageNav memberCardEnabled={memberCardEnabled} />
      {/* 形3（UI_RULES 2章）: カード1列、見出しと説明はカードの中 */}
      <Layout>
        {/* お知らせ枠は 1 つまで（契約を読めなかったときだけ） */}
        {!isInhouse && !subscriptionsRead && (
          <Layout.Section>
            <Banner tone="warning" title="契約の状態を Shopify から読めませんでした">
              <Text as="p">前に読めたプランのまま使えます。少し待ってから再読み込みしてください。</Text>
            </Banner>
          </Layout.Section>
        )}

        {/* ── 現在のプラン ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" gap="200">
                <BlockStack gap="100">
                  <Text variant="headingMd" as="h2">現在のプラン</Text>
                  <Text tone="subdued" as="p">
                    {isInhouse
                      ? "自社用のため課金はありません。全機能を使えます。"
                      : "プランの選択・変更・解約は Shopify の料金プラン画面で行います。"}
                  </Text>
                </BlockStack>
                <Badge tone={planBadge.tone}>{planBadge.text}</Badge>
              </InlineStack>

              {!isInhouse && activeSubscriptions.length > 0 && (
                <BlockStack gap="100">
                  {activeSubscriptions.map((sub) => (
                    <Text key={sub.id || sub.name} tone="subdued" as="p">
                      {sub.name}・次回更新 {formatDate(sub.currentPeriodEnd)}
                    </Text>
                  ))}
                </BlockStack>
              )}

              {!isInhouse && subscriptionsRead && !hasSubscription && (
                <Text tone="subdued" as="p">有効な契約がありません。Lite の機能は使えます。売上サマリー・入店数報告・予算管理は Pro を選ぶと使えます。</Text>
              )}

              {!isInhouse && pricingPlansUrl && (
                <InlineStack>
                  <Button variant="primary" onClick={openPricingPlans}>
                    {hasSubscription ? "プランを変更" : subscriptionsRead ? "プランを選ぶ" : "プランを確かめる"}
                  </Button>
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── プランと料金 ── */}
        <Layout.Section>
          <BlockStack gap="300">
            {/* カードの外の見出しは、スマホでもカードと同じ左右 16px の余白にそろえる */}
            <Box paddingInline={{ xs: "400", sm: "0" }}>
            <BlockStack gap="100">
              <Text variant="headingMd" as="h2">プランと料金</Text>
              <Text tone="subdued" as="p">
                {`Lite は${litePlan.maxLocations}ロケーション、Pro は${proPlan.maxLocations}ロケーションまで含みます。超えた分は 1 か所 $${extraLocationPriceUsd}/月です。`}
              </Text>
            </BlockStack>
            </Box>
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <PlanCard
                name={litePlan.name}
                priceSummary={`$${litePlan.amount}/月`}
                priceDetail={litePlan.priceNote}
                features={liteFeatures}
                isCurrent={!isInhouse && hasSubscription && isLite}
              />
              <PlanCard
                name={proPlan.name}
                priceSummary={`$${proPlan.amount}/月`}
                priceDetail={proPlan.priceNote}
                features={proFeatures}
                proOnlyKeys={proOnlyKeys}
                isCurrent={!isInhouse && hasSubscription && isPro}
              />
            </InlineGrid>
          </BlockStack>
        </Layout.Section>

        {!isInhouse && (
          <Layout.Section>
            <Card>
              <BlockStack gap="100">
                <Text variant="headingMd" as="h2">プランに含まれる数を超えたロケーション</Text>
                {extraLocationUsage && usageReportingEnabled ? (
                  <>
                    <Text as="p">
                      ロケーション {locationsCount} か所のうち、{extraLocationUsage.includedLocations} か所を超えた{" "}
                      <strong>{extraLocationUsage.units} か所</strong> × ${extraLocationUsage.unitPriceUsd} ＝{" "}
                      <strong>${extraLocationUsage.amountUsd}</strong>／請求期間（月額とは別に Shopify の請求に載ります）
                    </Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      請求期間ごとに 1 回、その時点のロケーション数で数えます。{usageReportNote ?? ""}
                    </Text>
                  </>
                ) : usageReportingEnabled ? (
                  <Text as="p" tone="subdued">
                    {extraLocationNotCountedText(extraLocationStatus, locationsCount, extraLocationPriceUsd)}
                  </Text>
                ) : (
                  <Text as="p" tone="subdued">
                    今は、プランに含まれる数を超えたロケーションの料金を請求していません（今のロケーション数: {locationsCount} か所）。
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
    </PolarisPageWrapper>
  );
}

/** 「2026-12-21T…」→「2026/12/21」。無ければ「—」（8章の形式） */
function formatDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10).replace(/-/g, "/") : "—";
}

/**
 * 超えたロケーションを数えていないときの文（スイッチがオンのとき）。
 * 契約が無い・読めない店に「プランの範囲内です」と出さない（レビュー #41 の P2-2）。
 */
function extraLocationNotCountedText(status: string, locationsCount: number, priceUsd: number): string {
  switch (status) {
    case "within_plan":
      return `超えた分は 1 か所 $${priceUsd}/月です。今のロケーション数（${locationsCount} か所）はプランの範囲内です。`;
    case "no_subscription":
      return `有効な契約が無いため、超えたロケーションは数えていません（今のロケーション数: ${locationsCount} か所）。プランを選ぶと、プランに含まれる数を超えた分は 1 か所 $${priceUsd}/月です。`;
    case "unread":
      return `契約の状態を Shopify から読めないため、超えたロケーションをまだ数えていません（今のロケーション数: ${locationsCount} か所）。少し待ってから再読み込みしてください。`;
    default:
      return `今のプランでは、超えたロケーションの料金はかかりません（今のロケーション数: ${locationsCount} か所）。`;
  }
}

// ── サブコンポーネント ─────────────────────────────────────────────────────────

function PlanCard({
  name,
  priceSummary,
  priceDetail,
  features,
  proOnlyKeys,
  isCurrent,
}: {
  name: string;
  priceSummary: string;
  priceDetail: string;
  features: { key: string; label: string }[];
  proOnlyKeys?: Set<string>;
  isCurrent: boolean;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingMd" as="h3">{name}</Text>
          {isCurrent && <Badge tone="success">ご契約中</Badge>}
        </InlineStack>
        <BlockStack gap="050">
          <Text variant="headingLg" as="p">{priceSummary}</Text>
          <Text as="p" tone="subdued" variant="bodySm">{priceDetail}</Text>
        </BlockStack>
        <Divider />
        <List type="bullet">
          {features.map((f) => (
            <List.Item key={f.key}>
              {f.label}
              {proOnlyKeys?.has(f.key) ? "（Pro のみ）" : ""}
            </List.Item>
          ))}
        </List>
      </BlockStack>
    </Card>
  );
}
