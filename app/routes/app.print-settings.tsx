/**
 * /app/print-settings — 印字設定（要件 §12）
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
  PRINT_SETTINGS_KEY,
  DEFAULT_PRINT_SETTINGS,
  type PrintSettings,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const PRINT_MODE_OPTIONS = [
  { label: "CloudPRNT 直印字", value: "cloudprnt_direct" },
  { label: "注文経由（order_based）", value: "order_based" },
];
const PAPER_WIDTH_OPTIONS = [
  { label: "58mm", value: "58mm" },
  { label: "80mm", value: "80mm" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY);
  const settings: PrintSettings = { ...DEFAULT_PRINT_SETTINGS, ...saved };
  return { settings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const str = (k: string, d: string) => String(get(k) ?? d).trim();
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const settings: PrintSettings = {
    ...DEFAULT_PRINT_SETTINGS,
    defaultPrintMode: (get("defaultPrintMode") as PrintSettings["defaultPrintMode"]) || "order_based",
    locationPrintModeOverrideEnabled: bool("locationPrintModeOverrideEnabled", true),
    cloudprntProfileName: str("cloudprntProfileName", ""),
    cloudprntPaperWidth: str("cloudprntPaperWidth", "80mm"),
    cloudprntEnabled: bool("cloudprntEnabled", false),
    createSettlementOrderWhenPrinting: bool("createSettlementOrderWhenPrinting", true),
    attachSettlementNoteToOrder: bool("attachSettlementNoteToOrder", true),
    attachSettlementMetafieldsToOrder: bool("attachSettlementMetafieldsToOrder", true),
    receiptPrintMode: str("receiptPrintMode", "order_based"),
    receiptPreviewBeforePrintRequired: bool("receiptPreviewBeforePrintRequired", true),
  };
  await setAppSetting(shop.id, PRINT_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function PrintSettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<PrintSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      fd.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    });
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="印字設定"
        backAction={{ content: "戻る", onAction: () => navigate("/app/settings" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Layout>
          {saved && <Layout.Section><Banner tone="success">保存しました。</Banner></Layout.Section>}
          <Layout.Section>
            <Banner tone="info">ショップ全体のデフォルト印字方式・CloudPRNT・order_based 時の挙動・領収書印字を設定します。ロケーション別の上書きは設定ページのロケーション設定で行います。</Banner>
          </Layout.Section>

          <Layout.AnnotatedSection title="印字方式" description="§12.2.1">
            <Card>
              <BlockStack gap="400">
                <Select label="デフォルト印字方式" options={PRINT_MODE_OPTIONS} value={form.defaultPrintMode} onChange={(v) => set("defaultPrintMode", v as PrintSettings["defaultPrintMode"])} />
                <Checkbox label="ロケーション別で印字方式を上書き可能" checked={form.locationPrintModeOverrideEnabled} onChange={(v) => set("locationPrintModeOverrideEnabled", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="CloudPRNT" description="§12.2.2">
            <Card>
              <BlockStack gap="400">
                <Checkbox label="CloudPRNT を有効にする" checked={form.cloudprntEnabled} onChange={(v) => set("cloudprntEnabled", v)} />
                <TextField label="プロファイル名" value={form.cloudprntProfileName} onChange={(v) => set("cloudprntProfileName", v)} autoComplete="off" />
                <Select label="用紙幅" options={PAPER_WIDTH_OPTIONS} value={form.cloudprntPaperWidth} onChange={(v) => set("cloudprntPaperWidth", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="order-based 時の挙動" description="§12.2.3">
            <Card>
              <BlockStack gap="300">
                <Checkbox label="印字時に精算注文を作成" checked={form.createSettlementOrderWhenPrinting} onChange={(v) => set("createSettlementOrderWhenPrinting", v)} />
                <Checkbox label="精算メモを注文に付与" checked={form.attachSettlementNoteToOrder} onChange={(v) => set("attachSettlementNoteToOrder", v)} />
                <Checkbox label="精算メタフィールドを注文に付与" checked={form.attachSettlementMetafieldsToOrder} onChange={(v) => set("attachSettlementMetafieldsToOrder", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="領収書印字" description="§12.2.4">
            <Card>
              <BlockStack gap="400">
                <TextField label="領収書印字方式" value={form.receiptPrintMode} onChange={(v) => set("receiptPrintMode", v)} helpText="例: order_based" autoComplete="off" />
                <Checkbox label="印字前にプレビュー必須" checked={form.receiptPreviewBeforePrintRequired} onChange={(v) => set("receiptPreviewBeforePrintRequired", v)} />
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
