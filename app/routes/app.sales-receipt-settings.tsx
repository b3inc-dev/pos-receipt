/**
 * /app/sales-receipt-settings — 販売レシート ON/OFF（注文まとめて／商品別属性）
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
  SALES_RECEIPT_SETTINGS_KEY,
  DEFAULT_SALES_RECEIPT_SETTINGS,
  type SalesReceiptSettings,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, RECEIPT_TABS } from "../components/TabGroupBar";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<SalesReceiptSettings>>(
    shop.id,
    SALES_RECEIPT_SETTINGS_KEY,
  );
  const settings: SalesReceiptSettings = {
    ...DEFAULT_SALES_RECEIPT_SETTINGS,
    ...saved,
    layoutJson: {
      ...DEFAULT_SALES_RECEIPT_SETTINGS.layoutJson,
      ...(saved?.layoutJson ?? {}),
    },
  };
  return { settings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const bool = (k: string) => get(k) === "true";
  const str = (k: string, d: string) => String(get(k) ?? d);
  const settings: SalesReceiptSettings = {
    enabled: bool("enabled"),
    printOrderAttributes: bool("printOrderAttributes"),
    printLineAttributes: bool("printLineAttributes"),
    paperWidthMm: str("paperWidthMm", "80") === "58" ? 58 : 80,
    headerTitle: str("headerTitle", DEFAULT_SALES_RECEIPT_SETTINGS.headerTitle),
    footerNote: str("footerNote", DEFAULT_SALES_RECEIPT_SETTINGS.footerNote),
    layoutJson: {
      showSku: bool("showSku"),
      showPayments: bool("showPayments"),
      showLocation: bool("showLocation"),
    },
  };
  await setAppSetting(shop.id, SALES_RECEIPT_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function SalesReceiptSettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState(initial);

  const handleSave = () => {
    const fd = new FormData();
    fd.set("enabled", form.enabled ? "true" : "false");
    fd.set("printOrderAttributes", form.printOrderAttributes ? "true" : "false");
    fd.set("printLineAttributes", form.printLineAttributes ? "true" : "false");
    fd.set("paperWidthMm", String(form.paperWidthMm));
    fd.set("headerTitle", form.headerTitle);
    fd.set("footerNote", form.footerNote);
    fd.set("showSku", form.layoutJson.showSku ? "true" : "false");
    fd.set("showPayments", form.layoutJson.showPayments ? "true" : "false");
    fd.set("showLocation", form.layoutJson.showLocation ? "true" : "false");
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="販売レシート設定"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Card padding="0">
          <TabGroupBar tabs={RECEIPT_TABS} />
        </Card>
        <Layout>
          {saved && (
            <Layout.Section>
              <Banner tone="success">保存しました。</Banner>
            </Layout.Section>
          )}
          <Layout.Section>
            <Banner tone="info">
              Lite プラン以上で利用できます。注文まとめて（order customAttributes）／商品別（line
              properties）の末尾印字を個別に ON/OFF できます。
            </Banner>
          </Layout.Section>
          <Layout.AnnotatedSection title="有効化" description="POS の販売レシート印字">
            <Card>
              <BlockStack gap="400">
                <Checkbox
                  label="販売レシート印字を有効にする"
                  checked={form.enabled}
                  onChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
                />
                <Select
                  label="用紙幅"
                  options={[
                    { label: "80mm", value: "80" },
                    { label: "58mm", value: "58" },
                  ]}
                  value={String(form.paperWidthMm)}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, paperWidthMm: v === "58" ? 58 : 80 }))
                  }
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
          <Layout.AnnotatedSection
            title="属性末尾印字"
            description="注文まとめて／商品別の ON/OFF"
          >
            <Card>
              <BlockStack gap="400">
                <Checkbox
                  label="注文属性を末尾に印字（注文まとめて）"
                  checked={form.printOrderAttributes}
                  onChange={(v) => setForm((p) => ({ ...p, printOrderAttributes: v }))}
                />
                <Checkbox
                  label="商品属性を各行末尾に印字（商品別）"
                  checked={form.printLineAttributes}
                  onChange={(v) => setForm((p) => ({ ...p, printLineAttributes: v }))}
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
          <Layout.AnnotatedSection title="ヘッダ・フッタ" description="印字文言">
            <Card>
              <BlockStack gap="400">
                <TextField
                  label="ヘッダタイトル"
                  value={form.headerTitle}
                  onChange={(v) => setForm((p) => ({ ...p, headerTitle: v }))}
                  autoComplete="off"
                />
                <TextField
                  label="フッタ文言"
                  value={form.footerNote}
                  onChange={(v) => setForm((p) => ({ ...p, footerNote: v }))}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
          <Layout.Section>
            <InlineStack align="end">
              <Button variant="primary" onClick={handleSave}>
                保存
              </Button>
            </InlineStack>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
