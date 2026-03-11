/**
 * /app/voucher-settings — 商品券設定
 * 要件 §7: 商品券機能・額面読取・精算反映
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
  VOUCHER_SETTINGS_KEY,
  DEFAULT_VOUCHER_SETTINGS,
  type VoucherSettings,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const PRIORITY_OPTIONS = [
  { label: "手動優先", value: "manual_first" },
  { label: "自動優先", value: "auto_first" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<VoucherSettings>>(shop.id, VOUCHER_SETTINGS_KEY);
  const settings: VoucherSettings = { ...DEFAULT_VOUCHER_SETTINGS, ...saved };
  return { settings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const settings: VoucherSettings = {
    ...DEFAULT_VOUCHER_SETTINGS,
    voucherFeatureEnabled: bool("voucherFeatureEnabled", true),
    voucherAutoDetectionEnabled: bool("voucherAutoDetectionEnabled", true),
    voucherManualAdjustmentEnabled: bool("voucherManualAdjustmentEnabled", true),
    voucherNoteParseEnabled: bool("voucherNoteParseEnabled", false),
    voucherNoteParseRegex: String(get("voucherNoteParseRegex") ?? "").trim(),
    voucherDefaultLabel: String(get("voucherDefaultLabel") ?? "商品券").trim(),
    voucherAdjustmentPriority: (get("voucherAdjustmentPriority") as "manual_first" | "auto_first") || "manual_first",
    reflectVoucherChangeInSettlement: bool("reflectVoucherChangeInSettlement", true),
    reflectVoucherChangeInReceiptDisplay: bool("reflectVoucherChangeInReceiptDisplay", true),
    voucherChangeDisplayLabel: String(get("voucherChangeDisplayLabel") ?? "商品券おつり").trim(),
  };
  await setAppSetting(shop.id, VOUCHER_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function VoucherSettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<VoucherSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    fd.set("voucherFeatureEnabled", form.voucherFeatureEnabled ? "true" : "false");
    fd.set("voucherAutoDetectionEnabled", form.voucherAutoDetectionEnabled ? "true" : "false");
    fd.set("voucherManualAdjustmentEnabled", form.voucherManualAdjustmentEnabled ? "true" : "false");
    fd.set("voucherNoteParseEnabled", form.voucherNoteParseEnabled ? "true" : "false");
    fd.set("voucherNoteParseRegex", form.voucherNoteParseRegex);
    fd.set("voucherDefaultLabel", form.voucherDefaultLabel);
    fd.set("voucherAdjustmentPriority", form.voucherAdjustmentPriority);
    fd.set("reflectVoucherChangeInSettlement", form.reflectVoucherChangeInSettlement ? "true" : "false");
    fd.set("reflectVoucherChangeInReceiptDisplay", form.reflectVoucherChangeInReceiptDisplay ? "true" : "false");
    fd.set("voucherChangeDisplayLabel", form.voucherChangeDisplayLabel);
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = <K extends keyof VoucherSettings>(key: K, value: VoucherSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="商品券設定"
        backAction={{ content: "戻る", onAction: () => navigate("/app/settings" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Layout>
          {saved && <Layout.Section><Banner tone="success">保存しました。</Banner></Layout.Section>}
          <Layout.Section>
            <Banner tone="info">
              商品券の有効化・額面読取ルール・精算への反映を設定します。
            </Banner>
          </Layout.Section>

          <Layout.AnnotatedSection title="商品券機能全体" description="§7.2.1">
            <Card>
              <BlockStack gap="300">
                <Checkbox label="商品券機能を有効にする" checked={form.voucherFeatureEnabled} onChange={(v) => set("voucherFeatureEnabled", v)} />
                <Checkbox label="自動判定を有効にする" checked={form.voucherAutoDetectionEnabled} onChange={(v) => set("voucherAutoDetectionEnabled", v)} />
                <Checkbox label="手動調整を有効にする" checked={form.voucherManualAdjustmentEnabled} onChange={(v) => set("voucherManualAdjustmentEnabled", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="額面読取ルール" description="§7.2.2">
            <Card>
              <BlockStack gap="400">
                <Checkbox label="注文ノートから額面を読取る" checked={form.voucherNoteParseEnabled} onChange={(v) => set("voucherNoteParseEnabled", v)} />
                <TextField label="読取用正規表現" value={form.voucherNoteParseRegex} onChange={(v) => set("voucherNoteParseRegex", v)} autoComplete="off" />
                <TextField label="デフォルトラベル" value={form.voucherDefaultLabel} onChange={(v) => set("voucherDefaultLabel", v)} autoComplete="off" />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="判定優先順位・精算反映" description="§7.2.3, §7.2.4">
            <Card>
              <BlockStack gap="400">
                <Select label="判定優先順位" options={PRIORITY_OPTIONS} value={form.voucherAdjustmentPriority} onChange={(v) => set("voucherAdjustmentPriority", v as "manual_first" | "auto_first")} />
                <Checkbox label="精算に商品券おつりを反映する" checked={form.reflectVoucherChangeInSettlement} onChange={(v) => set("reflectVoucherChangeInSettlement", v)} />
                <Checkbox label="レシート表示に商品券おつりを反映する" checked={form.reflectVoucherChangeInReceiptDisplay} onChange={(v) => set("reflectVoucherChangeInReceiptDisplay", v)} />
                <TextField label="商品券おつりの表示ラベル" value={form.voucherChangeDisplayLabel} onChange={(v) => set("voucherChangeDisplayLabel", v)} autoComplete="off" />
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
