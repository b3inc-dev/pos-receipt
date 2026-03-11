/**
 * /app/settings — 管理画面設定ページ
 * 要件書 §10: 管理画面
 *
 * - プラン状態確認・アップグレード導線
 * - ロケーション別設定（印字方式・売上サマリー・入店数報告）
 * - 領収書テンプレート設定リンク
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  Select,
  Checkbox,
  Banner,
  Divider,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { planLabel, isInhouseMode, PLAN_FEATURES } from "../utils/planFeatures.server";

const LOCATIONS_QUERY = `#graphql
  query Locations {
    locations(first: 50, includeLegacy: false) {
      edges {
        node { id name isActive }
      }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  // Shopify ロケーション一覧取得
  const locRes = await admin.graphql(LOCATIONS_QUERY);
  const locJson = await locRes.json() as {
    data?: {
      locations?: {
        edges?: { node: { id: string; name: string; isActive: boolean } }[];
      };
    };
  };
  const shopifyLocations = (locJson.data?.locations?.edges ?? [])
    .map((e) => e.node)
    .filter((l) => l.isActive);

  // DB ロケーション設定取得
  const dbLocations = await prisma.location.findMany({ where: { shopId: shop.id } });
  const dbMap = new Map(dbLocations.map((l) => [l.shopifyLocationGid, l]));

  const locations = shopifyLocations.map((sl) => {
    const db = dbMap.get(sl.id);
    return {
      id: sl.id,
      name: sl.name,
      printMode: db?.printMode ?? "order_based",
      salesSummaryEnabled: db?.salesSummaryEnabled ?? false,
      footfallReportingEnabled: db?.footfallReportingEnabled ?? false,
    };
  });

  return {
    shop: { id: shop.id, planCode: shop.planCode, planLabel: planLabel(shop.planCode) },
    isInhouse: isInhouseMode(),
    locations,
    proFeatures: PLAN_FEATURES.pro,
    standardFeatures: PLAN_FEATURES.standard,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const formData = await request.formData();
  const locationId = String(formData.get("locationId") ?? "");
  const printMode = String(formData.get("printMode") ?? "order_based");
  const salesSummaryEnabled = formData.get("salesSummaryEnabled") === "true";
  const footfallReportingEnabled = formData.get("footfallReportingEnabled") === "true";

  if (locationId) {
    await prisma.location.upsert({
      where: { shopId_shopifyLocationGid: { shopId: shop.id, shopifyLocationGid: locationId } },
      update: { printMode, salesSummaryEnabled, footfallReportingEnabled },
      create: {
        shopId: shop.id,
        shopifyLocationGid: locationId,
        name: String(formData.get("locationName") ?? ""),
        printMode,
        salesSummaryEnabled,
        footfallReportingEnabled,
      },
    });
  }

  return Response.json({ ok: true });
}

export default function SettingsPage() {
  const { shop, isInhouse, locations } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const isPro = isInhouse || shop.planCode === "pro" || shop.planCode === "unlimited";

  const handleLocationChange = (
    locationId: string,
    locationName: string,
    field: string,
    value: string | boolean
  ) => {
    const loc = locations.find((l) => l.id === locationId);
    if (!loc) return;
    const fd = new FormData();
    fd.set("locationId", locationId);
    fd.set("locationName", locationName);
    fd.set("printMode", field === "printMode" ? String(value) : loc.printMode);
    fd.set(
      "salesSummaryEnabled",
      String(field === "salesSummaryEnabled" ? value : loc.salesSummaryEnabled)
    );
    fd.set(
      "footfallReportingEnabled",
      String(field === "footfallReportingEnabled" ? value : loc.footfallReportingEnabled)
    );
    submit(fd, { method: "post" });
  };

  return (
    <Page
      title="設定"
      primaryAction={{ content: "領収書テンプレート設定", url: "/app/receipt-template" }}
      backAction={{ url: "/app" }}
    >
      <Layout>
        {/* ── プラン状態 ── */}
        <Layout.AnnotatedSection
          title="プラン"
          description="ご契約中のプランと利用できる機能を確認できます。プロプランでは売上サマリー・予算管理・入店数報告が利用可能です。"
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">現在のプラン</Text>
                <Badge tone={isPro ? "success" : "info"}>
                  {shop.planLabel}
                </Badge>
              </InlineStack>

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

              {!isInhouse && (
                <Button url="/app/settings/billing" variant="plain">
                  プラン・課金管理
                </Button>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── ロケーション設定 ── */}
        <Layout.AnnotatedSection
          title="ロケーション設定"
          description="各店舗の印字方式と売上サマリー設定を管理します。売上サマリー・入店数報告はプロプランが必要です。"
        >
          <Card>
            <BlockStack gap="400">
              {locations.length === 0 && (
                <Text tone="subdued" as="p">ロケーションが見つかりません。</Text>
              )}

              {locations.map((loc, i) => (
                <Box key={loc.id}>
                  {i > 0 && <Divider />}
                  <Box paddingBlockStart={i > 0 ? "400" : "0"}>
                    <BlockStack gap="300">
                      <Text variant="headingSm" as="h3">{loc.name}</Text>

                      <Select
                        label="印字方式"
                        options={[
                          { label: "注文経由（CloudPRNT非対応）", value: "order_based" },
                          { label: "CloudPRNT直印字", value: "cloudprnt_direct" },
                        ]}
                        value={loc.printMode}
                        onChange={(v) => handleLocationChange(loc.id, loc.name, "printMode", v)}
                      />

                      <Checkbox
                        label="売上サマリー有効"
                        helpText="このロケーションを売上サマリーの集計対象にします"
                        checked={loc.salesSummaryEnabled}
                        disabled={!isPro}
                        onChange={(v) =>
                          handleLocationChange(loc.id, loc.name, "salesSummaryEnabled", v)
                        }
                      />

                      <Checkbox
                        label="入店数報告有効"
                        helpText="POSの売上サマリー画面に入店数入力欄を表示します"
                        checked={loc.footfallReportingEnabled}
                        disabled={!isPro}
                        onChange={(v) =>
                          handleLocationChange(loc.id, loc.name, "footfallReportingEnabled", v)
                        }
                      />
                    </BlockStack>
                  </Box>
                </Box>
              ))}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}
