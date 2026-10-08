/**
 * /app/sales-receipt-layout — ビジュアル編集（販売レシート主）
 * プレビュー HTML は印字と同じ renderPrintReceiptHtml を使用。
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
  Box,
} from "@shopify/polaris";
import { useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  getAppSetting,
  setAppSetting,
  SALES_RECEIPT_SETTINGS_KEY,
  DEFAULT_SALES_RECEIPT_SETTINGS,
  type SalesReceiptSettings,
} from "../utils/appSettings.server";
import { renderPrintReceiptHtml } from "../services/printReceiptHtml";
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
  const prev =
    (await getAppSetting<Partial<SalesReceiptSettings>>(shop.id, SALES_RECEIPT_SETTINGS_KEY)) ??
    {};
  const settings: SalesReceiptSettings = {
    ...DEFAULT_SALES_RECEIPT_SETTINGS,
    ...prev,
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

function buildSampleHtml(settings: SalesReceiptSettings): string {
  return renderPrintReceiptHtml({
    kind: "sales",
    shopName: settings.headerTitle || "レシート",
    orderName: "#1042",
    createdAtLabel: "2026/10/08 13:45",
    locationName: settings.layoutJson.showLocation ? "渋谷店" : "",
    currency: "JPY",
    subtotal: 3300,
    tax: 300,
    discounts: 200,
    total: 3400,
    lineItems: [
      {
        title: "サンプル商品 A",
        variantTitle: "M / 黒",
        quantity: 1,
        unitPrice: 2000,
        lineTotal: 2000,
        sku: settings.layoutJson.showSku ? "SKU-A" : "",
        customAttributes: settings.printLineAttributes
          ? [
              { key: "名入れ", value: "太郎" },
              { key: "包装", value: "あり" },
            ]
          : [],
      },
      {
        title: "サンプル商品 B",
        quantity: 2,
        unitPrice: 750,
        lineTotal: 1500,
        customAttributes: [],
      },
    ],
    orderAttributes: settings.printOrderAttributes
      ? [
          { key: "来店目的", value: "ギフト" },
          { key: "スタッフメモ", value: "袋不要" },
        ]
      : [],
    payments: settings.layoutJson.showPayments
      ? [
          { label: "現金", amount: 2000 },
          { label: "クレジットカード", amount: 1400 },
        ]
      : [],
    footerNote: settings.footerNote,
    showOrderAttributes: settings.printOrderAttributes,
    showLineAttributes: settings.printLineAttributes,
    paperWidthMm: settings.paperWidthMm,
  });
}

export default function SalesReceiptLayoutPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState(initial);

  const previewHtml = useMemo(() => buildSampleHtml(form), [form]);

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
        title="販売レイアウト編集"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Card padding="0">
          <TabGroupBar tabs={RECEIPT_TABS} />
        </Card>
        <Layout>
          {saved && (
            <Layout.Section>
              <Banner tone="success">保存しました。プレビューは印字 HTML と同一レンダラです。</Banner>
            </Layout.Section>
          )}
          <Layout.Section>
            <Banner tone="info">
              精算・領収書も同一 HTML レンダラ（printReceiptHtml）を利用します。販売レシートの見た目をここで調整し、印字結果と一致させます。
            </Banner>
          </Layout.Section>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  編集
                </Text>
                <Checkbox
                  label="販売レシートを有効"
                  checked={form.enabled}
                  onChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
                />
                <TextField
                  label="ヘッダタイトル"
                  value={form.headerTitle}
                  onChange={(v) => setForm((p) => ({ ...p, headerTitle: v }))}
                  autoComplete="off"
                />
                <TextField
                  label="フッタ"
                  value={form.footerNote}
                  onChange={(v) => setForm((p) => ({ ...p, footerNote: v }))}
                  autoComplete="off"
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
                <Checkbox
                  label="注文属性（末尾）"
                  checked={form.printOrderAttributes}
                  onChange={(v) => setForm((p) => ({ ...p, printOrderAttributes: v }))}
                />
                <Checkbox
                  label="商品属性（行末尾）"
                  checked={form.printLineAttributes}
                  onChange={(v) => setForm((p) => ({ ...p, printLineAttributes: v }))}
                />
                <Checkbox
                  label="ロケーション表示"
                  checked={form.layoutJson.showLocation}
                  onChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      layoutJson: { ...p.layoutJson, showLocation: v },
                    }))
                  }
                />
                <Checkbox
                  label="支払内訳"
                  checked={form.layoutJson.showPayments}
                  onChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      layoutJson: { ...p.layoutJson, showPayments: v },
                    }))
                  }
                />
                <Checkbox
                  label="SKU（サンプル表示）"
                  checked={form.layoutJson.showSku}
                  onChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      layoutJson: { ...p.layoutJson, showSku: v },
                    }))
                  }
                />
                <InlineStack align="end">
                  <Button variant="primary" onClick={handleSave}>
                    保存
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  印字プレビュー（同一 HTML）
                </Text>
                <Box
                  padding="300"
                  background="bg-surface-secondary"
                  borderRadius="200"
                  borderWidth="025"
                  borderColor="border"
                >
                  <iframe
                    title="sales-receipt-preview"
                    srcDoc={previewHtml}
                    style={{
                      width: "100%",
                      minHeight: 480,
                      border: "none",
                      background: "#fff",
                    }}
                  />
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
