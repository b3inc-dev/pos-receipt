/**
 * /app/general-settings — 一般設定（要件 §3）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit, useLocation, useNavigate } from "react-router";
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
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

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
  return { settings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const str = (k: string, d: string) => String(get(k) ?? d).trim();
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const settings: GeneralSettings = {
    ...DEFAULT_GENERAL_SETTINGS,
    appDisplayName: str("appDisplayName", ""),
    supportContactEmail: str("supportContactEmail", ""),
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
  await setAppSetting(shop.id, GENERAL_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function GeneralSettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<GeneralSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      fd.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    });
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="一般設定"
        backAction={{ content: "戻る", onAction: () => navigate("/app/settings" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Layout>
          {saved && <Layout.Section><Banner tone="success">保存しました。</Banner></Layout.Section>}
          <Layout.Section>
            <Banner tone="info">アプリ全体の基本情報・タイムゾーン・デバッグ表示を設定します。</Banner>
          </Layout.Section>

          <Layout.AnnotatedSection title="アプリ基本情報" description="§3.2.1">
            <Card>
              <BlockStack gap="400">
                <TextField label="アプリ表示名" value={form.appDisplayName} onChange={(v) => set("appDisplayName", v)} autoComplete="off" />
                <TextField label="サポート連絡先メール" value={form.supportContactEmail} onChange={(v) => set("supportContactEmail", v)} type="email" autoComplete="off" />
                <TextField label="デフォルトタイムゾーン" value={form.defaultTimezone} onChange={(v) => set("defaultTimezone", v)} helpText="例: Asia/Tokyo" autoComplete="off" />
                <TextField label="デフォルト通貨" value={form.defaultCurrency} onChange={(v) => set("defaultCurrency", v)} autoComplete="off" />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="プラン・表示言語" description="§3.2.2, §3.2.3">
            <Card>
              <BlockStack gap="400">
                <Select label="プラン（表示用）" options={PLAN_OPTIONS} value={form.currentPlanCode} onChange={(v) => set("currentPlanCode", v)} />
                <TextField label="有効機能 JSON（表示用）" value={form.enabledFeaturesJson} onChange={(v) => set("enabledFeaturesJson", v)} multiline={2} autoComplete="off" />
                <Select label="管理画面言語" options={LANG_OPTIONS} value={form.adminLanguage} onChange={(v) => set("adminLanguage", v)} />
                <Select label="POS 言語" options={LANG_OPTIONS} value={form.posLanguage} onChange={(v) => set("posLanguage", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="ログ・デバッグ" description="§3.2.4">
            <Card>
              <BlockStack gap="300">
                <Checkbox label="デバッグモード" checked={form.debugModeEnabled} onChange={(v) => set("debugModeEnabled", v)} helpText="ON 時のみ診断情報を増やす" />
                <Checkbox label="診断パネルを有効にする" checked={form.diagnosticsPanelEnabled} onChange={(v) => set("diagnosticsPanelEnabled", v)} />
                <Checkbox label="詳細計算ログ" checked={form.verboseCalcLogEnabled} onChange={(v) => set("verboseCalcLogEnabled", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.Section>
            <InlineStack align="end"><Button variant="primary" onClick={handleSave}>保存</Button></InlineStack>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
