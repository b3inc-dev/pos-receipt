/**
 * /app/loyalty-settings — ポイント/会員施策設定
 * 要件 §9A: loyalty_usage の表示名・抽出元（discount_code_prefix / manual_off 等）
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
  LOYALTY_SETTINGS_KEY,
  DEFAULT_LOYALTY_SETTINGS,
  type LoyaltySettings,
  type LoyaltyUsageSourceType,
} from "../utils/appSettings.server";
import { resolvePointRedemptionRules, validatePointRedemptionRules } from "../utils/pointRedemptionRules";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { SystemPageNav } from "../components/SystemPageNav";

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
  // 精算で今使っている見分け方（保存値が壊れていれば初めの値）をそのまま見せる
  const rules = resolvePointRedemptionRules(saved);
  settings.pointRedemptionCodePrefixes = rules.codePrefixes;
  settings.pointRedemptionManualTitles = rules.manualTitles;
  settings.pointRedemptionLegacyShopPointHexCode = rules.legacyShopPointHexCode;

  return { settings };
}

function formDataToSettings(
  formData: FormData,
): { ok: true; settings: LoyaltySettings } | { ok: false; error: string } {
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
  const rules = validatePointRedemptionRules({
    codePrefixes: String(get("pointRedemptionCodePrefixes") ?? ""),
    manualTitles: String(get("pointRedemptionManualTitles") ?? ""),
    legacyShopPointHexCode: get("pointRedemptionLegacyShopPointHexCode") !== "false",
  });
  if (!rules.ok) return rules;
  const settings: LoyaltySettings = {
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
    pointRedemptionCodePrefixes: rules.rules.codePrefixes,
    pointRedemptionManualTitles: rules.rules.manualTitles,
    pointRedemptionLegacyShopPointHexCode: rules.rules.legacyShopPointHexCode,
  };
  return { ok: true, settings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const formData = await request.formData();
  const parsed = formDataToSettings(formData);
  if (!parsed.ok) {
    return Response.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  await setAppSetting(shop.id, LOYALTY_SETTINGS_KEY, parsed.settings);
  return Response.json({ ok: true, at: Date.now() });
}

export default function LoyaltySettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  // 「←」とタブは、未保存の変更があれば Shopify の確認を出してから移る（UI ルール v1.1 7章）
  const navigate = useGuardedNavigate();
  const q = location.search || "";
  const actionData = useActionData<{ ok: boolean; error?: string; at?: number }>();
  const [form, setForm] = useState<LoyaltySettings>({ ...initial });
  const [pointPrefixText, setPointPrefixText] = useState(initial.pointRedemptionCodePrefixes.join("\n"));
  const [pointTitleText, setPointTitleText] = useState(initial.pointRedemptionManualTitles.join("\n"));

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
    fd.set("pointRedemptionCodePrefixes", pointPrefixText);
    fd.set("pointRedemptionManualTitles", pointTitleText);
    fd.set(
      "pointRedemptionLegacyShopPointHexCode",
      form.pointRedemptionLegacyShopPointHexCode ? "true" : "false",
    );
    submit(fd, { method: "post" });
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
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
      >
        <SystemPageNav memberCardEnabled={false} />
        {/* 保存は Shopify の保存の帯（値が保存したときと違うときだけ「破棄」「保存」）。画面の中に保存ボタンを置かない（UI ルール v1.1 7章） */}
        <StateSaveForm values={{ form, pointPrefixText, pointTitleText }} onSave={handleSave} onDiscard={(saved) => { setForm(saved.form); setPointPrefixText(saved.pointPrefixText); setPointTitleText(saved.pointTitleText); }} result={actionData}>
          <Layout>
            {/* 保存の成功はトーストで出し、保存のたびに出す（UI ルール v1.1 7章） */}
            <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
            {actionData?.ok === false && actionData.error && (
              <Layout.Section>
                <Banner tone="critical">保存していません。{actionData.error}</Banner>
              </Layout.Section>
            )}

            <Layout.Section>
              {/* 画面全体の説明は AdminIntro（1〜2文）。お知らせ枠は1画面に1つまでにする（2章・5章） */}
              <AdminIntro><p>精算・売上サマリーで表示する「ポイント利用額」の表示名と抽出方法を設定します。特定のポイントアプリに依存せず、割引コードのプレフィックスやメタフィールドで判定できます。</p></AdminIntro>
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
                      helpText="この欄は今は精算に使われていません。精算で数える割引は下の「精算のポイント利用額に数える割引」で決めます。"
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
              title="精算のポイント利用額に数える割引"
              description="ここに当てはまる割引は、精算・売上サマリーで「割引」ではなく「ポイント利用額」に入ります。上の「ポイント利用額を有効にする」に関係なく使います。前の注文の VIP- も数えるので消さないでください。Shop Point の設定でコードの頭を変えたら、ここと ciara-system の「会員ポイントの設定」も合わせてください。"
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="割引コードの頭（1 行に 1 つ）"
                    value={pointPrefixText}
                    onChange={setPointPrefixText}
                    multiline={3}
                    helpText="この文字で始まる割引コードを数えます。最後はハイフンにします（例: VIP-、SP-POINT-）。大文字と小文字は区別しません。"
                    autoComplete="off"
                  />
                  <Checkbox
                    label="Shop Point の前の形のコード（SP ＋ 16 桁の英数字、ハイフンなし）も数える"
                    checked={form.pointRedemptionLegacyShopPointHexCode}
                    onChange={(v) => set("pointRedemptionLegacyShopPointHexCode", v)}
                  />
                  <TextField
                    label="コードの無い割引の名前（1 行に 1 つ）"
                    value={pointTitleText}
                    onChange={setPointTitleText}
                    multiline={2}
                    helpText="POS で Shop Point を使うと、この名前の割引がカートに入ります（例: Shop Point）。自動割引は同じ名前でも数えません。"
                    autoComplete="off"
                  />
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

          </Layout>
        </StateSaveForm>
      </Page>
    </PolarisPageWrapper>
  );
}
