/**
 * /app — 管理画面トップ
 */
import type { ReactNode } from "react";
import type { LoaderFunctionArgs } from "react-router";
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
  return {
    planCode: shop.planCode === "standard" ? "lite" : (shop.planCode ?? "lite"),
    planLabel: fullAccess
      ? (isInhouseMode() ? "自社用（無制限）" : "全機能利用可能")
      : planLabel(shop.planCode),
    isInhouse: fullAccess,
    distribution: isInhouseMode() ? "inhouse" : "public",
    privacyPolicyUrl,
  };
}

export default function AppIndex() {
  const { planCode, planLabel: label, isInhouse, distribution, privacyPolicyUrl } =
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
              <Button onClick={to("/app/special-refund-history")}>特殊返金履歴</Button>
              {(isInhouse || isPro) && (
                <Button onClick={to("/app/budget-management")}>予算管理</Button>
              )}
            </HomeCard>

            <HomeCard
              title="用紙と印字"
              description="用紙幅が精算・点検・領収書・販売レシートのどれに対応するかを印字設定で確認します。"
            >
              <Button onClick={to("/app/print-settings")} variant="primary">印字設定を開く</Button>
              <Button onClick={to("/app/settlement-print-layout")}>精算印字プレビュー</Button>
            </HomeCard>

            <HomeCard
              title="領収書"
              description="発行者情報（会社名・住所・電話番号）や但し書きのデフォルト値を設定します。"
            >
              <Button onClick={to("/app/receipt-template")} variant="primary">テンプレート設定を開く</Button>
              <Button onClick={to("/app/receipt-history")}>領収書履歴</Button>
            </HomeCard>

            <HomeCard
              title="ロケーション"
              description="印字方式と売上サマリーの有効化を、店舗ごとに設定します。"
            >
              <Button onClick={to("/app/settings")} variant="primary">設定を開く</Button>
              {!isInhouse && (
                <Button onClick={to("/app/plan")} variant={isPro ? "plain" : "primary"}>
                  {isPro ? "プラン詳細" : "プロプランへ"}
                </Button>
              )}
            </HomeCard>

            <HomeCard
              title="システム診断"
              description="接続中のショップ情報、直近のアクティビティ、必須環境変数の設定状態を確認します。"
            >
              <Button onClick={to("/app/diagnostics")} variant="primary">診断ページを開く</Button>
            </HomeCard>

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
