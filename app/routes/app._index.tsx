/**
 * /app — 管理画面トップ
 */
import type { ReactNode } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { isDevelopmentStore } from "../utils/devStore.server";
import { useLoaderData, useLocation, useNavigate } from "react-router";
import {
  Page,
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
import { planLabel, getFullAccess, isInhouseMode } from "../utils/planFeatures.server";
import {
  getAppSetting,
  GENERAL_SETTINGS_KEY,
  type GeneralSettings,
} from "../utils/appSettings.server";
import { resolvePrivacyPolicyUrl } from "../utils/privacyPolicyUrl";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const fullAccess = await getFullAccess(admin, session);
  const general = await getAppSetting<Partial<GeneralSettings>>(shop.id, GENERAL_SETTINGS_KEY);
  const privacyPolicyUrl = resolvePrivacyPolicyUrl(general?.privacyPolicyUrl);
  // 「システム診断」の枠は開発ストアだけに出す（T さんの決定 2026-11-22。読めなければ出さない）
  const isDevStore = await isDevelopmentStore(admin);
  return {
    planCode: shop.planCode === "standard" ? "lite" : (shop.planCode ?? "lite"),
    planLabel: fullAccess
      ? (isInhouseMode() ? "自社用（無制限）" : "全機能利用可能")
      : planLabel(shop.planCode),
    isInhouse: fullAccess,
    distribution: isInhouseMode() ? "inhouse" : "public",
    privacyPolicyUrl,
    isDevStore,
  };
}

export default function AppIndex() {
  const { planCode, planLabel: label, isInhouse, distribution, privacyPolicyUrl, isDevStore } =
    useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const isPro = isInhouse || planCode === "pro" || planCode === "unlimited";
  const q = location.search || "";

  const to = (path: string) => () => navigate(path + q);

  return (
    <PolarisPageWrapper>
      <Page title="ホーム">
        <div className="AdminHome">
          <div className="AdminHome-summary">
            <Card>
              <BlockStack gap="300">
                <p className="AdminHome-title">現在のプラン</p>
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  <Text variant="headingLg" as="p">{label}</Text>
                  <Badge tone={isPro ? "success" : "info"}>
                    {distribution === "inhouse" ? "自社用" : "公開用"}
                  </Badge>
                </InlineStack>
                <p className="AdminHome-copy">
                  精算・特殊返金・領収書などは POS アプリのタイルから利用できます。
                </p>
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
                  <p className="AdminHome-copy">全機能が利用可能です。</p>
                )}
              </BlockStack>
            </Card>
          </div>

          <div className="AdminHome-main">
            <HomeCard
              title="精算・点検"
              description="日付、ロケーション、金額を履歴で比較します。"
            >
              <Button onClick={to("/app/settlement-history")} variant="primary">精算履歴を開く</Button>
              <Button onClick={to("/app/special-refund-history")}>調整履歴</Button>
            </HomeCard>

            <HomeCard title="レシート" description="販売・ギフト・領収書・精算／点検の基本設定とデザインを編集します。">
              <Button onClick={to("/app/receipt-layouts")} variant="primary">レシートのデザインを開く</Button>
              <Button onClick={to("/app/print-settings")}>プリンター・印字設定</Button>
              <Button onClick={to("/app/receipt-history")}>領収書履歴</Button>
            </HomeCard>
            <HomeCard title="レポート" description="売上サマリー・店舗予算・販売チャネルの管理を選びます。">
              <Button onClick={to("/app/reports")} variant="primary">レポート一覧を開く</Button>
              <Button onClick={to("/app/sales-summary-settings")}>サマリー設定</Button>
              <Button onClick={to("/app/sales-channels")}>チャネル管理</Button>
            </HomeCard>

            <HomeCard
              title="店舗一覧"
              description="店舗ごとの機能・表示名・並び順を設定します。"
            >
              <Button onClick={to("/app/settings")} variant="primary">設定を開く</Button>
              {!isInhouse && (
                <Button onClick={to("/app/plan")} variant={isPro ? "plain" : "primary"}>
                  {isPro ? "プラン詳細" : "プロプランへ"}
                </Button>
              )}
            </HomeCard>

            {/* システム診断は開発ストアだけ（main 88f0d80・T さんの決定 2026-11-22） */}
            {isDevStore && (
              <HomeCard
                title="システム診断"
                description="接続中のショップ情報、直近のアクティビティ、必須環境変数の設定状態を確認します。"
              >
                <Button onClick={to("/app/diagnostics")} variant="primary">診断ページを開く</Button>
              </HomeCard>
            )}

            <HomeCard
              title="プライバシー"
              description={
                privacyPolicyUrl
                  ? "プライバシーポリシーを確認できます。"
                  : "プライバシーポリシー URL が未設定です。一般設定で設定してください。"
              }
            >
              {privacyPolicyUrl ? (
                <Button url={privacyPolicyUrl} external variant="primary">
                  プライバシーポリシーを開く
                </Button>
              ) : (
                <Button onClick={to("/app/general-settings")} variant="primary">一般設定を開く</Button>
              )}
            </HomeCard>
          </div>
        </div>
      </Page>
    </PolarisPageWrapper>
  );
}

function HomeCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <p className="AdminHome-title">{title}</p>
        <p className="AdminHome-copy">{description}</p>
        <InlineStack gap="200" wrap>
          {children}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
