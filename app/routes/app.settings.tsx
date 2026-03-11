/**
 * /app/settings — 管理画面設定ページ
 * 要件書 §10: 管理画面
 *
 * - プラン状態確認・アップグレード導線
 * - ロケーション別設定（印字方式・売上サマリー・入店数報告）
 * - 領収書テンプレート設定リンク
 */
import { useMemo, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator, useLocation, useNavigate } from "react-router";
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
  TextField,
  Banner,
  Divider,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { planLabel, getFullAccess, isInhouseMode, PLAN_FEATURES } from "../utils/planFeatures.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

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
      displayName: db?.displayName ?? null,
      shortName: db?.shortName ?? null,
      sortOrder: db?.sortOrder ?? 0,
      printMode: db?.printMode ?? "order_based",
      salesSummaryEnabled: db?.salesSummaryEnabled ?? false,
      footfallReportingEnabled: db?.footfallReportingEnabled ?? false,
      settlementEnabled: db?.settlementEnabled ?? true,
      receiptEnabled: db?.receiptEnabled ?? true,
      specialRefundEnabled: db?.specialRefundEnabled ?? true,
      voucherAdjustmentEnabled: db?.voucherAdjustmentEnabled ?? true,
      inspectionReceiptEnabled: db?.inspectionReceiptEnabled ?? true,
      includeInStoreTotals: (db as { includeInStoreTotals?: boolean } | undefined)?.includeInStoreTotals ?? true,
      includeInOverallTotals: (db as { includeInOverallTotals?: boolean } | undefined)?.includeInOverallTotals ?? true,
      visibleInSummaryDefault: (db as { visibleInSummaryDefault?: boolean } | undefined)?.visibleInSummaryDefault ?? true,
      printerProfileId: (db as { printerProfileId?: string | null } | undefined)?.printerProfileId ?? null,
      cloudprntEnabled: (db as { cloudprntEnabled?: boolean } | undefined)?.cloudprntEnabled ?? false,
      summaryTargetGroup: (db as { summaryTargetGroup?: string | null } | undefined)?.summaryTargetGroup ?? null,
      budgetTargetEnabled: (db as { budgetTargetEnabled?: boolean } | undefined)?.budgetTargetEnabled ?? false,
      footfallTargetEnabled: (db as { footfallTargetEnabled?: boolean } | undefined)?.footfallTargetEnabled ?? false,
    };
  });
  // sort_order で並べ替え（要件 §4.2.1）
  locations.sort((a, b) => a.sortOrder - b.sortOrder);

  const fullAccess = await getFullAccess(admin, session);
  return {
    shop: {
      id: shop.id,
      planCode: shop.planCode,
      planLabel: fullAccess
        ? (isInhouseMode() ? "自社用（無制限）" : "全機能利用可能")
        : planLabel(shop.planCode),
    },
    isInhouse: fullAccess,
    locations,
    proFeatures: PLAN_FEATURES.pro,
    standardFeatures: PLAN_FEATURES.standard,
  };
}

/** 一括保存用。formData.locations に JSON 配列を渡す（要件 §4） */
type LocationPayload = {
  id: string;
  name: string;
  displayName?: string | null;
  shortName?: string | null;
  sortOrder?: number;
  printMode?: string;
  salesSummaryEnabled?: boolean;
  footfallReportingEnabled?: boolean;
  settlementEnabled?: boolean;
  receiptEnabled?: boolean;
  specialRefundEnabled?: boolean;
  voucherAdjustmentEnabled?: boolean;
  inspectionReceiptEnabled?: boolean;
  includeInStoreTotals?: boolean;
  includeInOverallTotals?: boolean;
  visibleInSummaryDefault?: boolean;
  printerProfileId?: string | null;
  cloudprntEnabled?: boolean;
  summaryTargetGroup?: string | null;
  budgetTargetEnabled?: boolean;
  footfallTargetEnabled?: boolean;
};

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const formData = await request.formData();
  const locationsJson = formData.get("locations");

  if (typeof locationsJson === "string") {
    try {
      const locations = JSON.parse(locationsJson) as LocationPayload[];
      for (const loc of locations) {
        if (!loc?.id) continue;
        await prisma.location.upsert({
          where: { shopId_shopifyLocationGid: { shopId: shop.id, shopifyLocationGid: loc.id } },
          update: {
            displayName: loc.displayName ?? null,
            shortName: loc.shortName ?? null,
            sortOrder: loc.sortOrder ?? 0,
            printMode: loc.printMode ?? "order_based",
            salesSummaryEnabled: Boolean(loc.salesSummaryEnabled),
            footfallReportingEnabled: Boolean(loc.footfallReportingEnabled),
            settlementEnabled: loc.settlementEnabled !== false,
            receiptEnabled: loc.receiptEnabled !== false,
            specialRefundEnabled: loc.specialRefundEnabled !== false,
            voucherAdjustmentEnabled: loc.voucherAdjustmentEnabled !== false,
            inspectionReceiptEnabled: loc.inspectionReceiptEnabled !== false,
            includeInStoreTotals: loc.includeInStoreTotals !== false,
            includeInOverallTotals: loc.includeInOverallTotals !== false,
            visibleInSummaryDefault: loc.visibleInSummaryDefault !== false,
            printerProfileId: loc.printerProfileId ?? null,
            cloudprntEnabled: Boolean(loc.cloudprntEnabled),
            summaryTargetGroup: loc.summaryTargetGroup ?? null,
            budgetTargetEnabled: Boolean(loc.budgetTargetEnabled),
            footfallTargetEnabled: Boolean(loc.footfallTargetEnabled),
          },
          create: {
            shopId: shop.id,
            shopifyLocationGid: loc.id,
            name: loc.name ?? "",
            displayName: loc.displayName ?? null,
            shortName: loc.shortName ?? null,
            sortOrder: loc.sortOrder ?? 0,
            printMode: loc.printMode ?? "order_based",
            salesSummaryEnabled: Boolean(loc.salesSummaryEnabled),
            footfallReportingEnabled: Boolean(loc.footfallReportingEnabled),
            settlementEnabled: loc.settlementEnabled !== false,
            receiptEnabled: loc.receiptEnabled !== false,
            specialRefundEnabled: loc.specialRefundEnabled !== false,
            voucherAdjustmentEnabled: loc.voucherAdjustmentEnabled !== false,
            inspectionReceiptEnabled: loc.inspectionReceiptEnabled !== false,
            includeInStoreTotals: loc.includeInStoreTotals !== false,
            includeInOverallTotals: loc.includeInOverallTotals !== false,
            visibleInSummaryDefault: loc.visibleInSummaryDefault !== false,
            printerProfileId: loc.printerProfileId ?? null,
            cloudprntEnabled: Boolean(loc.cloudprntEnabled),
            summaryTargetGroup: loc.summaryTargetGroup ?? null,
            budgetTargetEnabled: Boolean(loc.budgetTargetEnabled),
            footfallTargetEnabled: Boolean(loc.footfallTargetEnabled),
          },
        });
      }
    } catch {
      return Response.json({ ok: false, error: "Invalid locations data" }, { status: 400 });
    }
  }

  return Response.json({ ok: true });
}

/** 設定用カードのスタイル（ADMIN_UI_DESIGN_RULES §7.1.2） */
const SETTING_CARD_STYLE: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 12,
  boxShadow: "0 0 0 1px #e1e3e5",
  padding: 16,
};

export default function SettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const { shop, isInhouse, locations: initialLocations } = loaderData;
  const [locations, setLocations] = useState(initialLocations);
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const revalidator = useRevalidator();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const isPro = isInhouse || shop.planCode === "pro" || shop.planCode === "unlimited";
  const to = (path: string) => () => navigate(path + q);

  const isDirty = useMemo(
    () => JSON.stringify(locations) !== JSON.stringify(initialLocations),
    [locations, initialLocations]
  );
  const saving = fetcher.state !== "idle";
  const saveOk = fetcher.data?.ok === true;
  const saveErr = fetcher.data?.ok === false ? fetcher.data.error : null;

  useEffect(() => {
    setLocations(loaderData.locations);
  }, [loaderData.locations]);

  const lastAppliedSaveRef = useRef<unknown>(null);
  useEffect(() => {
    const data = fetcher.data;
    if (!data?.ok || lastAppliedSaveRef.current === data) return;
    lastAppliedSaveRef.current = data;
    revalidator.revalidate();
  }, [fetcher.data, revalidator]);

  const [showSavedFeedback, setShowSavedFeedback] = useState(false);
  const lastShowSavedRef = useRef<unknown>(null);
  useEffect(() => {
    const data = fetcher.data;
    if (!data?.ok || lastShowSavedRef.current === data) return;
    lastShowSavedRef.current = data;
    setShowSavedFeedback(true);
    const t = setTimeout(() => setShowSavedFeedback(false), 3000);
    return () => clearTimeout(t);
  }, [fetcher.data]);

  const handleLocationChange = (
    locationId: string,
    _locationName: string,
    field: keyof (typeof locations)[0],
    value: string | number | boolean | null
  ) => {
    setLocations((prev) =>
      prev.map((loc) =>
        loc.id !== locationId ? loc : { ...loc, [field]: value }
      )
    );
  };

  const handleSave = () => {
    const fd = new FormData();
    fd.set("locations", JSON.stringify(locations));
    fetcher.submit(fd, { method: "post" });
  };

  const handleDiscard = () => {
    setLocations(initialLocations);
  };

  const footerStatusText =
    saving ? "保存中..." : isDirty ? "未保存の変更があります" : "";
  const showFooter = isDirty || saving || showSavedFeedback;

  return (
    <PolarisPageWrapper>
    <Page
      title="設定"
      primaryAction={{ content: "領収書テンプレート設定", onAction: to("/app/receipt-template") }}
      secondaryActions={[
        { content: "一般設定", onAction: to("/app/general-settings") },
        { content: "精算設定", onAction: to("/app/settlement-settings") },
        { content: "印字設定", onAction: to("/app/print-settings") },
        { content: "売上サマリー設定", onAction: to("/app/sales-summary-settings") },
        { content: "ポイント/会員施策設定", onAction: to("/app/loyalty-settings") },
        { content: "商品券設定", onAction: to("/app/voucher-settings") },
        { content: "特殊返金設定", onAction: to("/app/special-refund-settings") },
        { content: "予算設定", onAction: to("/app/budget-settings") },
      ]}
      backAction={{ content: "戻る", onAction: to("/app") }}
    >
      <Layout>
        {saveErr && (
          <Layout.Section>
            <Banner tone="critical">保存エラー: {saveErr}</Banner>
          </Layout.Section>
        )}
        {/* ── プラン状態 ── */}
        <Layout.AnnotatedSection
          title="プラン"
          description="ご契約中のプランと利用できる機能を確認できます。プロプランでは売上サマリー・予算管理・入店数報告が利用可能です。"
        >
          <div style={SETTING_CARD_STYLE}>
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
                    <Button onClick={to("/app/plan")} variant="primary">
                      プロプランにアップグレード
                    </Button>
                  </BlockStack>
                </Banner>
              )}

              {(isInhouse || isPro) && (
                <Text tone="subdued" as="p">全機能が利用可能です。</Text>
              )}

              {!isInhouse && (
                <Button onClick={to("/app/plan")} variant="plain">
                  プラン・課金管理
                </Button>
              )}
            </BlockStack>
          </div>
        </Layout.AnnotatedSection>

        {/* ── ロケーション設定（POS Stock 同様：設定用カードスタイル・固定フッターで保存） ── */}
        <Layout.AnnotatedSection
          title="ロケーション設定"
          description="各店舗の印字方式と売上サマリー設定を管理します。売上サマリー・入店数報告はプロプランが必要です。"
        >
          <div style={SETTING_CARD_STYLE}>
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

                      <InlineStack gap="300" blockAlign="start">
                        <div style={{ flex: "1 1 200px" }}>
                          <TextField
                            label="表示名"
                            value={loc.displayName ?? ""}
                            onChange={(v) =>
                              handleLocationChange(loc.id, loc.name, "displayName", v || null)
                            }
                            placeholder={loc.name}
                            helpText="レシート・管理画面で使う名前（未入力はShopify名）"
                            autoComplete="off"
                          />
                        </div>
                        <div style={{ flex: "0 0 120px" }}>
                          <TextField
                            label="短縮名"
                            value={loc.shortName ?? ""}
                            onChange={(v) =>
                              handleLocationChange(loc.id, loc.name, "shortName", v || null)
                            }
                            placeholder="例: 本店"
                            autoComplete="off"
                          />
                        </div>
                        <div style={{ flex: "0 0 80px" }}>
                          <TextField
                            label="並び順"
                            type="number"
                            value={String(loc.sortOrder)}
                            onChange={(v) =>
                              handleLocationChange(loc.id, loc.name, "sortOrder", parseInt(v, 10) || 0)
                            }
                            autoComplete="off"
                          />
                        </div>
                      </InlineStack>

                      <Select
                        label="印字方式"
                        options={[
                          { label: "注文経由（CloudPRNT非対応）", value: "order_based" },
                          { label: "CloudPRNT直印字", value: "cloudprnt_direct" },
                        ]}
                        value={loc.printMode}
                        onChange={(v) => handleLocationChange(loc.id, loc.name, "printMode", v)}
                      />

                      <Text variant="bodySm" as="p" tone="subdued">機能有効（§4.2.2）</Text>
                      <InlineStack gap="400" wrap>
                        <Checkbox
                          label="精算"
                          checked={loc.settlementEnabled}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "settlementEnabled", v)
                          }
                        />
                        <Checkbox
                          label="領収書"
                          checked={loc.receiptEnabled}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "receiptEnabled", v)
                          }
                        />
                        <Checkbox
                          label="特殊返金"
                          checked={loc.specialRefundEnabled}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "specialRefundEnabled", v)
                          }
                        />
                        <Checkbox
                          label="商品券調整"
                          checked={loc.voucherAdjustmentEnabled}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "voucherAdjustmentEnabled", v)
                          }
                        />
                        <Checkbox
                          label="点検レシート"
                          checked={loc.inspectionReceiptEnabled}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "inspectionReceiptEnabled", v)
                          }
                        />
                        <Checkbox
                          label="売上サマリー"
                          helpText="集計対象"
                          checked={loc.salesSummaryEnabled}
                          disabled={!isPro}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "salesSummaryEnabled", v)
                          }
                        />
                        <Checkbox
                          label="入店数報告"
                          checked={loc.footfallReportingEnabled}
                          disabled={!isPro}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "footfallReportingEnabled", v)
                          }
                        />
                      </InlineStack>

                      <Text variant="bodySm" as="p" tone="subdued">集計・表示対象（§4.2.3）</Text>
                      <InlineStack gap="400" wrap>
                        <Checkbox
                          label="店舗合計に含める"
                          checked={loc.includeInStoreTotals}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "includeInStoreTotals", v)
                          }
                        />
                        <Checkbox
                          label="全体合計に含める"
                          checked={loc.includeInOverallTotals}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "includeInOverallTotals", v)
                          }
                        />
                        <Checkbox
                          label="サマリーでデフォルト表示"
                          checked={loc.visibleInSummaryDefault}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "visibleInSummaryDefault", v)
                          }
                        />
                      </InlineStack>

                      <InlineStack gap="300" blockAlign="start">
                        <TextField
                          label="プリンタプロファイルID（§4.2.4）"
                          value={loc.printerProfileId ?? ""}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "printerProfileId", v || null)
                          }
                          placeholder="任意"
                          autoComplete="off"
                        />
                        <Checkbox
                          label="CloudPRNT有効"
                          checked={loc.cloudprntEnabled}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "cloudprntEnabled", v)
                          }
                        />
                      </InlineStack>

                      <Text variant="bodySm" as="p" tone="subdued">売上サマリー関連（§4.2.5）</Text>
                      <InlineStack gap="400" wrap>
                        <TextField
                          label="サマリー対象グループ"
                          value={loc.summaryTargetGroup ?? ""}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "summaryTargetGroup", v || null)
                          }
                          placeholder="任意"
                          autoComplete="off"
                        />
                        <Checkbox
                          label="予算対象"
                          checked={loc.budgetTargetEnabled}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "budgetTargetEnabled", v)
                          }
                        />
                        <Checkbox
                          label="入店数対象"
                          checked={loc.footfallTargetEnabled}
                          onChange={(v) =>
                            handleLocationChange(loc.id, loc.name, "footfallTargetEnabled", v)
                          }
                        />
                      </InlineStack>
                    </BlockStack>
                  </Box>
                </Box>
              ))}
            </BlockStack>
          </div>
        </Layout.AnnotatedSection>

        {/* ── システム診断 ── */}
        <Layout.AnnotatedSection
          title="システム診断"
          description="DB接続・テーブル件数・環境変数の設定状態を確認できます。"
        >
          <div style={SETTING_CARD_STYLE}>
            <BlockStack gap="200">
              <Text tone="subdued" as="p">
                障害調査や本番環境の設定確認に利用してください。
              </Text>
              <Button onClick={to("/app/diagnostics")} variant="plain">診断ページを開く</Button>
            </BlockStack>
          </div>
        </Layout.AnnotatedSection>
      </Layout>

      {/* 固定フッター（POS Stock 同様：変更時のみ表示・破棄・保存） */}
      {showFooter && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            background: "#fff",
            borderTop: "1px solid #e1e3e5",
            padding: "12px 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            boxShadow: "0 -2px 6px rgba(0,0,0,0.06)",
            zIndex: 100,
          }}
        >
          <span style={{ fontSize: 14, color: "#6d7175" }}>
            {showSavedFeedback && !isDirty ? "保存しました" : saveErr ? `保存エラー: ${saveErr}` : footerStatusText}
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={handleDiscard}
              disabled={saving || (showSavedFeedback && !isDirty)}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                border: "1px solid #c9cccf",
                background: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: saving || (showSavedFeedback && !isDirty) ? "not-allowed" : "pointer",
                color: "#202223",
              }}
            >
              破棄
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || (showSavedFeedback && !isDirty)}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                border: "none",
                background: "#2c6ecb",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: saving || (showSavedFeedback && !isDirty) ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      )}
    </Page>
    </PolarisPageWrapper>
  );
}
