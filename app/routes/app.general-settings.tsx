/**
 * /app/general-settings — 一般設定（要件 §3）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useSubmit, useLocation } from "react-router";
import { SuccessToast, AdminIntro, useGuardedNavigate } from "../components/admin-ui";
import { StateSaveForm } from "../components/StateSaveForm";
import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Checkbox,
  Button,
  BlockStack,
  Banner,
  InlineStack,
  Select,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  getAppSetting,
  setAppSetting,
  GENERAL_SETTINGS_KEY,
  DEFAULT_GENERAL_SETTINGS,
  type GeneralSettings,
} from "../utils/appSettings.server";
import {
  isAllowedPrivacyPolicyUrl,
  resolvePrivacyPolicyUrl,
} from "../utils/privacyPolicyUrl";
import { isDevelopmentStore, keepDevOnlySettings } from "../utils/devStore.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { SystemPageNav } from "../components/SystemPageNav";

const PLAN_OPTIONS = [
  { label: "Lite", value: "lite" },
  { label: "Pro", value: "pro" },
];
const LANG_OPTIONS = [{ label: "日本語", value: "ja" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<GeneralSettings>>(shop.id, GENERAL_SETTINGS_KEY);
  const settings: GeneralSettings = { ...DEFAULT_GENERAL_SETTINGS, ...saved };
  const effectivePrivacyPolicyUrl = resolvePrivacyPolicyUrl(settings.privacyPolicyUrl);
  const privacyPolicyFromEnvOnly =
    !settings.privacyPolicyUrl?.trim() && Boolean(effectivePrivacyPolicyUrl);
  // デバッグ・診断の欄は開発ストアだけに出す（T さんの決定 2026-11-22。読めなければ出さない）
  const isDevStore = await isDevelopmentStore(admin);
  return { settings, effectivePrivacyPolicyUrl, privacyPolicyFromEnvOnly, isDevStore };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const str = (k: string, d: string) => String(get(k) ?? d).trim();
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const privacyPolicyUrlRaw = str("privacyPolicyUrl", "");
  if (privacyPolicyUrlRaw && !isAllowedPrivacyPolicyUrl(privacyPolicyUrlRaw)) {
    return Response.json(
      { ok: false, error: "プライバシーポリシー URL は http(s) で始まる有効な URL を指定してください。" },
      { status: 400 }
    );
  }
  const submitted: GeneralSettings = {
    ...DEFAULT_GENERAL_SETTINGS,
    appDisplayName: str("appDisplayName", ""),
    supportContactEmail: str("supportContactEmail", ""),
    privacyPolicyUrl: privacyPolicyUrlRaw,
    defaultTimezone: str("defaultTimezone", "Asia/Tokyo"),
    defaultCurrency: str("defaultCurrency", "JPY"),
    currentPlanCode: str("currentPlanCode", "lite"),
    enabledFeaturesJson: str("enabledFeaturesJson", "{}"),
    adminLanguage: str("adminLanguage", "ja"),
    posLanguage: str("posLanguage", "ja"),
    debugModeEnabled: bool("debugModeEnabled", false),
    diagnosticsPanelEnabled: bool("diagnosticsPanelEnabled", true),
    verboseCalcLogEnabled: bool("verboseCalcLogEnabled", false),
  };
  // 開発ストアでない店では、画面に出していないデバッグ・診断の欄を保存済みの値のままにする
  const isDevStore = await isDevelopmentStore(admin);
  const saved: GeneralSettings = {
    ...DEFAULT_GENERAL_SETTINGS,
    ...(await getAppSetting<Partial<GeneralSettings>>(shop.id, GENERAL_SETTINGS_KEY)),
  };
  const settings = keepDevOnlySettings(submitted, saved, isDevStore);
  await setAppSetting(shop.id, GENERAL_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function GeneralSettingsPage() {
  const {
    settings: initial,
    effectivePrivacyPolicyUrl,
    privacyPolicyFromEnvOnly,
    isDevStore,
  } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const actionData = useActionData<{ ok?: boolean; error?: string }>();
  const location = useLocation();
  // 「←」とタブは、未保存の変更があれば Shopify の確認を出してから移る（UI ルール v1.1 7章）
  const navigate = useGuardedNavigate();
  const q = location.search || "";
  const [saveError, setSaveError] = useState<string | null>(null);
  const [form, setForm] = useState<GeneralSettings>({ ...initial });

  const handleSave = () => {
    setSaveError(null);
    if (form.privacyPolicyUrl.trim() && !isAllowedPrivacyPolicyUrl(form.privacyPolicyUrl)) {
      setSaveError("プライバシーポリシー URL は http(s) で始まる有効な URL を指定してください。");
      return false;
    }
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      fd.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    });
    submit(fd, { method: "post" });
  };

  const set = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="一般設定"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
      >
        <SystemPageNav memberCardEnabled={false} isDevStore={isDevStore} />
        {/* 保存は Shopify の保存の帯（値が保存したときと違うときだけ「破棄」「保存」）。画面の中に保存ボタンを置かない（UI ルール v1.1 7章） */}
        <StateSaveForm values={form} onSave={handleSave} onDiscard={(saved) => { setForm(saved); setSaveError(null); }} result={actionData}>
          <Layout>
            {/* 保存の成功はトーストで出し、保存のたびに出す（UI ルール v1.1 7章） */}
            <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
            {/* 保存の失敗は理由を赤いお知らせ 1 つで残す（UI ルール v1.1 7章） */}
            {(saveError || actionData?.ok === false) && (
              <Layout.Section>
                <Banner tone="critical">保存していません。{saveError ?? actionData?.error ?? "もう一度保存してください。"}</Banner>
              </Layout.Section>
            )}
            <Layout.Section>
              {/* 画面全体の説明は AdminIntro（1〜2文）。お知らせ枠は1画面に1つまでにする（2章・5章） */}
              <AdminIntro><p>{isDevStore ? "アプリ全体の基本情報・タイムゾーン・デバッグ表示を設定します。" : "アプリ全体の基本情報・タイムゾーンを設定します。"}</p></AdminIntro>
            </Layout.Section>

            <Layout.AnnotatedSection title="アプリ基本情報">
              <Card>
                <BlockStack gap="400">
                  <TextField label="アプリ表示名" value={form.appDisplayName} onChange={(v) => set("appDisplayName", v)} autoComplete="off" />
                  <TextField label="サポート連絡先メール" value={form.supportContactEmail} onChange={(v) => set("supportContactEmail", v)} type="email" autoComplete="off" />
                  <TextField
                    label="プライバシーポリシー URL"
                    value={form.privacyPolicyUrl}
                    onChange={(v) => set("privacyPolicyUrl", v)}
                    type="url"
                    autoComplete="off"
                    helpText="https で始まる公開 URL。未設定時はサーバー環境変数 PRIVACY_POLICY_URL があればそれを使います。ダミー URL は置かないでください。"
                  />
                  {effectivePrivacyPolicyUrl && (
                    <Text as="p" tone="subdued">
                      {/* 下線の文字リンクにしない（UI ルール v1.1 4章）。URL は文字だけで出す */}
                      現在有効: {effectivePrivacyPolicyUrl}
                      {privacyPolicyFromEnvOnly ? "（環境変数）" : ""}
                    </Text>
                  )}
                  <TextField label="デフォルトタイムゾーン" value={form.defaultTimezone} onChange={(v) => set("defaultTimezone", v)} helpText="例: Asia/Tokyo" autoComplete="off" />
                  <TextField label="デフォルト通貨" value={form.defaultCurrency} onChange={(v) => set("defaultCurrency", v)} autoComplete="off" />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection title={isDevStore ? "プラン・表示言語" : "表示言語"}>
              <Card>
                <BlockStack gap="400">
                  {/* 「プラン（表示用）」「有効機能 JSON（表示用）」は開発ストアだけに出す（客先の店には出さない） */}
                  {isDevStore && (
                    <>
                      <Select label="プラン（表示用）" options={PLAN_OPTIONS} value={form.currentPlanCode} onChange={(v) => set("currentPlanCode", v)} />
                      <TextField label="有効機能 JSON（表示用）" value={form.enabledFeaturesJson} onChange={(v) => set("enabledFeaturesJson", v)} multiline={2} autoComplete="off" />
                    </>
                  )}
                  <Select label="管理画面言語" options={LANG_OPTIONS} value={form.adminLanguage} onChange={(v) => set("adminLanguage", v)} />
                  <Select label="POS 言語" options={LANG_OPTIONS} value={form.posLanguage} onChange={(v) => set("posLanguage", v)} />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            {/* 開発ストアだけに出す（客先の店には出さない） */}
            {isDevStore && (
            <Layout.AnnotatedSection title="ログ・デバッグ">
              <Card>
                <BlockStack gap="300">
                  <Checkbox label="デバッグモード" checked={form.debugModeEnabled} onChange={(v) => set("debugModeEnabled", v)} helpText="ON 時のみ診断情報を増やす" />
                  <Checkbox label="診断パネルを有効にする" checked={form.diagnosticsPanelEnabled} onChange={(v) => set("diagnosticsPanelEnabled", v)} />
                  <Checkbox label="詳細計算ログ" checked={form.verboseCalcLogEnabled} onChange={(v) => set("verboseCalcLogEnabled", v)} />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
            )}
          </Layout>
        </StateSaveForm>
      </Page>
    </PolarisPageWrapper>
  );
}
