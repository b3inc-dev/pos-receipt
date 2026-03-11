/**
 * /app/loyalty-settings — ポイント/会員施策設定
 * 要件 §9A: loyalty_usage の表示名・抽出元（discount_code_prefix / manual_off 等）
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
  LOYALTY_SETTINGS_KEY,
  DEFAULT_LOYALTY_SETTINGS,
  type LoyaltySettings,
  type LoyaltyUsageSourceType,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const SOURCE_TYPE_OPTIONS: { label: string; value: LoyaltyUsageSourceType }[] = [
  { label: "使用しない", value: "manual_off" },
  { label: "割引コードのプレフィックスで判定", value: "discount_code_prefix" },
  { label: "注文メタフィールド", value: "order_metafield" },
  { label: "注文属性", value: "order_attribute" },
  { label: "アプリ独自イベント", value: "custom_app_event" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const saved = await getAppSetting<Partial<LoyaltySettings>>(shop.id, LOYALTY_SETTINGS_KEY);
  const settings: LoyaltySettings = {
    ...DEFAULT_LOYALTY_SETTINGS,
    ...saved,
    loyaltyUsageDiscountCodePrefixes: Array.isArray(saved?.loyaltyUsageDiscountCodePrefixes)
      ? saved.loyaltyUsageDiscountCodePrefixes
      : DEFAULT_LOYALTY_SETTINGS.loyaltyUsageDiscountCodePrefixes,
  };

  return { settings };
}

function formDataToSettings(formData: FormData): LoyaltySettings {
  const get = (k: string) => formData.get(k);
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const prefixesRaw = get("loyaltyUsageDiscountCodePrefixes");
  let prefixes: string[] = [];
  if (typeof prefixesRaw === "string" && prefixesRaw.trim()) {
    try {
      prefixes = JSON.parse(prefixesRaw) as string[];
    } catch {
      prefixes = prefixesRaw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return {
    ...DEFAULT_LOYALTY_SETTINGS,
    loyaltyUsageFeatureEnabled: bool("loyaltyUsageFeatureEnabled", false),
    loyaltyUsageDisplayLabel: String(get("loyaltyUsageDisplayLabel") ?? "ポイント利用額").trim(),
    loyaltyUsageSourceType: (get("loyaltyUsageSourceType") as LoyaltyUsageSourceType) || "manual_off",
    loyaltyUsageSourceConfigJson: String(get("loyaltyUsageSourceConfigJson") ?? "{}").trim(),
    loyaltyUsageDiscountCodePrefixes: prefixes,
    loyaltyUsageOrderMetafieldNamespace: (get("loyaltyUsageOrderMetafieldNamespace") as string) || null,
    loyaltyUsageOrderMetafieldKey: (get("loyaltyUsageOrderMetafieldKey") as string) || null,
    loyaltyUsageOrderAttributeKey: (get("loyaltyUsageOrderAttributeKey") as string) || null,
    loyaltyUsageIncludeInSummary: bool("loyaltyUsageIncludeInSummary", true),
    loyaltyUsageIncludeInSettlement: bool("loyaltyUsageIncludeInSettlement", true),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const formData = await request.formData();
  const settings = formDataToSettings(formData);
  await setAppSetting(shop.id, LOYALTY_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function LoyaltySettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<LoyaltySettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    fd.set("loyaltyUsageFeatureEnabled", form.loyaltyUsageFeatureEnabled ? "true" : "false");
    fd.set("loyaltyUsageDisplayLabel", form.loyaltyUsageDisplayLabel);
    fd.set("loyaltyUsageSourceType", form.loyaltyUsageSourceType);
    fd.set("loyaltyUsageSourceConfigJson", form.loyaltyUsageSourceConfigJson);
    fd.set("loyaltyUsageDiscountCodePrefixes", JSON.stringify(form.loyaltyUsageDiscountCodePrefixes));
    fd.set("loyaltyUsageOrderMetafieldNamespace", form.loyaltyUsageOrderMetafieldNamespace ?? "");
    fd.set("loyaltyUsageOrderMetafieldKey", form.loyaltyUsageOrderMetafieldKey ?? "");
    fd.set("loyaltyUsageOrderAttributeKey", form.loyaltyUsageOrderAttributeKey ?? "");
    fd.set("loyaltyUsageIncludeInSummary", form.loyaltyUsageIncludeInSummary ? "true" : "false");
    fd.set("loyaltyUsageIncludeInSettlement", form.loyaltyUsageIncludeInSettlement ? "true" : "false");
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = <K extends keyof LoyaltySettings>(key: K, value: LoyaltySettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const prefixText = form.loyaltyUsageDiscountCodePrefixes.join(", ");
  const setPrefixText = (text: string) => {
    const list = text.split(",").map((s) => s.trim()).filter(Boolean);
    setForm((prev) => ({ ...prev, loyaltyUsageDiscountCodePrefixes: list }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="ポイント/会員施策設定"
        backAction={{ content: "戻る", onAction: () => navigate("/app/settings" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Layout>
          {saved && (
            <Layout.Section>
              <Banner tone="success">保存しました。</Banner>
            </Layout.Section>
          )}

          <Layout.Section>
            <Banner tone="info">
              精算・売上サマリーで表示する「ポイント利用額」の表示名と抽出方法を設定します。特定のポイントアプリに依存せず、割引コードのプレフィックスやメタフィールドで判定できます。
            </Banner>
          </Layout.Section>

          <Layout.AnnotatedSection
            title="ポイント利用額の有無・表示名"
            description="機能を有効にすると、精算・サマリーにポイント利用額が表示されます。"
          >
            <Card>
              <BlockStack gap="400">
                <Checkbox
                  label="ポイント利用額を有効にする"
                  checked={form.loyaltyUsageFeatureEnabled}
                  onChange={(v) => set("loyaltyUsageFeatureEnabled", v)}
                />
                <TextField
                  label="表示名"
                  value={form.loyaltyUsageDisplayLabel}
                  onChange={(v) => set("loyaltyUsageDisplayLabel", v)}
                  helpText="精算レシート・売上サマリーで表示するラベル（例: ポイント利用額）"
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="抽出元（source_type）"
            description="どこからポイント利用額を取得するか。MVP では「使用しない」または「割引コードのプレフィックス」を推奨します。"
          >
            <Card>
              <BlockStack gap="400">
                <Select
                  label="抽出元"
                  options={SOURCE_TYPE_OPTIONS}
                  value={form.loyaltyUsageSourceType}
                  onChange={(v) => set("loyaltyUsageSourceType", v as LoyaltyUsageSourceType)}
                />
                {form.loyaltyUsageSourceType === "discount_code_prefix" && (
                  <TextField
                    label="割引コードのプレフィックス（カンマ区切り）"
                    value={prefixText}
                    onChange={setPrefixText}
                    helpText="例: VIP-, POINT-, APP- のいずれかで始まる割引をポイント利用額として集計"
                    autoComplete="off"
                  />
                )}
                {(form.loyaltyUsageSourceType === "order_metafield" || form.loyaltyUsageSourceType === "order_attribute") && (
                  <BlockStack gap="300">
                    <TextField
                      label="メタフィールド namespace（order_metafield 時）"
                      value={form.loyaltyUsageOrderMetafieldNamespace ?? ""}
                      onChange={(v) => set("loyaltyUsageOrderMetafieldNamespace", v || null)}
                      autoComplete="off"
                    />
                    <TextField
                      label="メタフィールド key（order_metafield 時）"
                      value={form.loyaltyUsageOrderMetafieldKey ?? ""}
                      onChange={(v) => set("loyaltyUsageOrderMetafieldKey", v || null)}
                      autoComplete="off"
                    />
                    <TextField
                      label="注文属性の key（order_attribute 時）"
                      value={form.loyaltyUsageOrderAttributeKey ?? ""}
                      onChange={(v) => set("loyaltyUsageOrderAttributeKey", v || null)}
                      autoComplete="off"
                    />
                  </BlockStack>
                )}
                {form.loyaltyUsageSourceType === "custom_app_event" && (
                  <TextField
                    label="設定 JSON（任意）"
                    value={form.loyaltyUsageSourceConfigJson}
                    onChange={(v) => set("loyaltyUsageSourceConfigJson", v)}
                    multiline={2}
                    autoComplete="off"
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="表示対象"
            description="サマリー・精算のどちらにポイント利用額を含めるか"
          >
            <Card>
              <BlockStack gap="300">
                <Checkbox
                  label="売上サマリーに含める"
                  checked={form.loyaltyUsageIncludeInSummary}
                  onChange={(v) => set("loyaltyUsageIncludeInSummary", v)}
                />
                <Checkbox
                  label="精算レシートに含める"
                  checked={form.loyaltyUsageIncludeInSettlement}
                  onChange={(v) => set("loyaltyUsageIncludeInSettlement", v)}
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.Section>
            <InlineStack align="end">
              <Button variant="primary" onClick={handleSave}>保存</Button>
            </InlineStack>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
