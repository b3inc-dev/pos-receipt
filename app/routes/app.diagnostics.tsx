/**
 * /app/diagnostics — システム診断ページ（管理者向け）
 * Epic H: 運用品質
 *
 * - DB 接続・テーブル件数
 * - ショップ情報・プランコード
 * - 環境変数の設定状態（値は非表示）
 * - 直近のエラー傾向（settlements / receipts の件数）
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  DataTable,
  Banner,
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, isInhouseMode, planLabel } from "../utils/planFeatures.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

// 環境変数の存在チェック（値は返さない）
const REQUIRED_ENV_VARS = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "DATABASE_URL",
  "SCOPES",
] as const;

const OPTIONAL_ENV_VARS = [
  "APP_DISTRIBUTION",
  "NODE_ENV",
] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  // ── DB カウント ────────────────────────────────────────────────────────────
  const [
    locationCount,
    settlementCount,
    receiptIssueCount,
    receiptTemplateCount,
    budgetCount,
    footfallCount,
    salesCacheCount,
  ] = await Promise.all([
    prisma.location.count({ where: { shopId: shop.id } }),
    prisma.settlement.count({ where: { shopId: shop.id } }),
    prisma.receiptIssue.count({ where: { shopId: shop.id } }),
    prisma.receiptTemplate.count({ where: { shopId: shop.id } }),
    prisma.budget.count({ where: { shopId: shop.id } }),
    prisma.footfallReport.count({ where: { shopId: shop.id } }),
    prisma.salesSummaryCacheDaily.count({ where: { shopId: shop.id } }),
  ]);

  // ── 直近 7 日間の精算・領収書件数 ─────────────────────────────────────────
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [recentSettlements, recentReceipts] = await Promise.all([
    prisma.settlement.count({
      where: { shopId: shop.id, createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.receiptIssue.count({
      where: { shopId: shop.id, createdAt: { gte: sevenDaysAgo } },
    }),
  ]);

  // ── 環境変数チェック ──────────────────────────────────────────────────────
  const envChecks = REQUIRED_ENV_VARS.map((key) => ({
    key,
    present: Boolean(process.env[key]),
    required: true,
  }));
  const optionalEnvChecks = OPTIONAL_ENV_VARS.map((key) => ({
    key,
    present: Boolean(process.env[key]),
    value: key === "NODE_ENV" ? (process.env[key] ?? "") : undefined,
    required: false,
  }));

  const fullAccess = await getFullAccess(admin, session);
  return {
    shop: {
      id: shop.id,
      domain: session.shop,
      planCode: shop.planCode === "standard" ? "lite" : (shop.planCode ?? "lite"),
      planLabel: fullAccess
        ? (isInhouseMode() ? "自社用（無制限）" : "全機能利用可能")
        : planLabel(shop.planCode),
    },
    isInhouse: fullAccess,
    dbCounts: {
      locationCount,
      settlementCount,
      receiptIssueCount,
      receiptTemplateCount,
      budgetCount,
      footfallCount,
      salesCacheCount,
    },
    recentActivity: {
      settlementsLast7Days: recentSettlements,
      receiptsLast7Days: recentReceipts,
    },
    envChecks,
    optionalEnvChecks,
    checkedAt: new Date().toISOString(),
  };
}

export default function DiagnosticsPage() {
  const {
    shop,
    isInhouse,
    dbCounts,
    recentActivity,
    envChecks,
    optionalEnvChecks,
    checkedAt,
  } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const missingRequired = envChecks.filter((e) => !e.present);
  const allEnvOk = missingRequired.length === 0;

  return (
    <PolarisPageWrapper>
    <Page
      title="システム診断"
      subtitle={`確認日時: ${new Date(checkedAt).toLocaleString("ja-JP")}`}
      backAction={{ content: "戻る", onAction: () => navigate("/app" + q) }}
    >
      <Layout>
        {/* ── 環境変数エラー ── */}
        {!allEnvOk && (
          <Layout.Section>
            <Banner tone="critical">
              <Text as="p">
                必須環境変数が未設定です: {missingRequired.map((e) => e.key).join(", ")}
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {/* ── ショップ情報 ── */}
        <Layout.AnnotatedSection
          title="ショップ情報"
          description="現在接続中のショップとプランを確認します。"
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">接続ショップ</Text>
                <Badge tone="success">接続済み</Badge>
              </InlineStack>
              <DataTable
                columnContentTypes={["text", "text"]}
                headings={["項目", "値"]}
                rows={[
                  ["ショップドメイン", shop.domain],
                  ["内部ID", shop.id],
                  ["プランコード", shop.planCode],
                  ["プランラベル", shop.planLabel],
                  ["自社用モード", isInhouse ? "有効" : "無効"],
                ]}
              />
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── DBテーブル件数 ── */}
        <Layout.AnnotatedSection
          title="DB テーブル件数"
          description="このショップのデータベースレコード数です。接続・書き込みが正常に機能しているか確認できます。"
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">レコード数</Text>
                <Badge tone="success">DB 接続正常</Badge>
              </InlineStack>
              <DataTable
                columnContentTypes={["text", "numeric"]}
                headings={["テーブル", "件数"]}
                rows={[
                  ["Location（ロケーション）", String(dbCounts.locationCount)],
                  ["Settlement（精算）", String(dbCounts.settlementCount)],
                  ["ReceiptIssue（領収書発行）", String(dbCounts.receiptIssueCount)],
                  ["ReceiptTemplate（テンプレート）", String(dbCounts.receiptTemplateCount)],
                  ["Budget（予算）", String(dbCounts.budgetCount)],
                  ["FootfallReport（入店数）", String(dbCounts.footfallCount)],
                  ["SalesSummaryCacheDaily（売上キャッシュ）", String(dbCounts.salesCacheCount)],
                ]}
              />
              <Divider />
              <Box>
                <Text variant="headingSm" as="h3">直近 7 日間のアクティビティ</Text>
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={["種別", "件数"]}
                  rows={[
                    ["精算", String(recentActivity.settlementsLast7Days)],
                    ["領収書発行", String(recentActivity.receiptsLast7Days)],
                  ]}
                />
              </Box>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── 環境変数チェック ── */}
        <Layout.AnnotatedSection
          title="環境変数"
          description="必須・任意の環境変数の設定状態を確認します。値は表示されません。"
        >
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">必須環境変数</Text>
                <DataTable
                  columnContentTypes={["text", "text"]}
                  headings={["環境変数", "状態"]}
                  rows={envChecks.map((e) => [
                    e.key,
                    e.present ? "✓ 設定済み" : "✗ 未設定",
                  ])}
                />
              </BlockStack>
              <Divider />
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">任意環境変数</Text>
                <DataTable
                  columnContentTypes={["text", "text", "text"]}
                  headings={["環境変数", "状態", "値（一部）"]}
                  rows={optionalEnvChecks.map((e) => [
                    e.key,
                    e.present ? "設定済み" : "未設定",
                    e.value ?? "—",
                  ])}
                />
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
    </PolarisPageWrapper>
  );
}
