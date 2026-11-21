/**
 * /app/receipt-print-layout — 領収書印字 HTML プレビュー（共通レンダラ）
 * テンプレート主要項目の ON/OFF + プレビュー＝ `/api/print/receipt/:id` と同一 HTML。
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
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  DEFAULT_TEMPLATE,
  normalizeTemplateData,
  type ReceiptTemplateData,
} from "./api.settings.receipt-template";
import {
  getAppSetting,
  setAppSetting,
  PRINT_SETTINGS_KEY,
  DEFAULT_PRINT_SETTINGS,
  type PrintSettings,
} from "../utils/appSettings.server";
import { loadSalesReceiptAttrFlags } from "../utils/loadSalesReceiptAttrFlags.server";
import { renderPrintReceiptHtml } from "../services/printReceiptHtml";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, RECEIPT_TABS } from "../components/TabGroupBar";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const tmpl = await prisma.receiptTemplate.findFirst({
    where: { shopId: shop.id, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  const template = normalizeTemplateData(
    tmpl ? (JSON.parse(tmpl.templateJson) as Record<string, unknown>) : { ...DEFAULT_TEMPLATE },
  );
  const printSettings = {
    ...DEFAULT_PRINT_SETTINGS,
    ...((await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {}),
  };
  const paperWidthMm = printSettings.cloudprntPaperWidth === "58mm" ? 58 : 80;
  const attrFlags = await loadSalesReceiptAttrFlags(shop.id);
  return { template, paperWidthMm, templateId: tmpl?.id ?? null, attrFlags };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const bool = (k: string) => get(k) === "true";
  const str = (k: string, d: string) => String(get(k) ?? d);

  const existing = await prisma.receiptTemplate.findFirst({
    where: { shopId: shop.id, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  const prev = normalizeTemplateData(
    existing
      ? (JSON.parse(existing.templateJson) as Record<string, unknown>)
      : { ...DEFAULT_TEMPLATE },
  );
  const next: ReceiptTemplateData = {
    ...prev,
    companyName: str("companyName", prev.companyName),
    address: str("address", prev.address),
    phone: str("phone", prev.phone),
    defaultProviso: str("defaultProviso", prev.defaultProviso),
    receiptTitle: str("receiptTitle", prev.receiptTitle || "領収書"),
    showOrderName: bool("showOrderName"),
    showIssueDate: bool("showIssueDate"),
    showLocationName: bool("showLocationName"),
  };
  next.showOrderNumber = next.showOrderName;
  next.showDate = next.showIssueDate;

  if (existing) {
    await prisma.receiptTemplate.update({
      where: { id: existing.id },
      data: {
        templateJson: JSON.stringify(next),
        version: (existing.version ?? 1) + 1,
        updatedAt: new Date(),
      },
    });
  } else {
    await prisma.receiptTemplate.create({
      data: {
        shopId: shop.id,
        name: "デフォルトテンプレート",
        templateJson: JSON.stringify(next),
        version: 1,
        isActive: true,
      },
    });
  }

  const paperWidthMm = str("paperWidthMm", "80") === "58" ? 58 : 80;
  const printSettings = {
    ...DEFAULT_PRINT_SETTINGS,
    ...((await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {}),
    cloudprntPaperWidth: paperWidthMm === 58 ? "58mm" : "80mm",
  };
  await setAppSetting(shop.id, PRINT_SETTINGS_KEY, printSettings);
  return Response.json({ ok: true });
}

function buildPreviewHtml(
  template: ReceiptTemplateData,
  paperWidthMm: 58 | 80,
  attrFlags: { printOrderAttributes: boolean; printLineAttributes: boolean },
): string {
  return renderPrintReceiptHtml({
    kind: "receipt",
    title: template.receiptTitle || "領　収　書",
    recipientName: "山田 太郎",
    proviso: template.defaultProviso || "お買上品代として",
    amount: 5400,
    currency: "JPY",
    issueDate: "2026-10-08",
    orderName: template.showOrderName ? "#1042" : undefined,
    locationName: template.showLocationName ? "渋谷店" : "",
    companyName: template.companyName,
    address: template.address,
    phone: template.phone,
    showOrderNumber: template.showOrderName,
    showDate: template.showIssueDate,
    showOrderAttributes: attrFlags.printOrderAttributes,
    showLineAttributes: attrFlags.printLineAttributes,
    orderAttributes: attrFlags.printOrderAttributes
      ? [{ key: "memo", value: "サンプル注文属性" }]
      : [],
    lineAttributes: attrFlags.printLineAttributes
      ? [{ key: "wrap", value: "gift" }]
      : [],
    paperWidthMm,
  });
}

export default function ReceiptPrintLayoutPage() {
  const {
    template: initial,
    paperWidthMm: initialPaper,
    attrFlags,
  } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState(initial);
  const [paperWidthMm, setPaperWidthMm] = useState<58 | 80>(
    initialPaper === 58 ? 58 : 80,
  );
  const previewHtml = useMemo(
    () => buildPreviewHtml(form, paperWidthMm, attrFlags),
    [form, paperWidthMm, attrFlags],
  );

  const handleSave = () => {
    const fd = new FormData();
    fd.set("companyName", form.companyName);
    fd.set("address", form.address);
    fd.set("phone", form.phone);
    fd.set("defaultProviso", form.defaultProviso);
    fd.set("receiptTitle", form.receiptTitle || "領収書");
    fd.set("showOrderName", form.showOrderName ? "true" : "false");
    fd.set("showIssueDate", form.showIssueDate ? "true" : "false");
    fd.set("showLocationName", form.showLocationName ? "true" : "false");
    fd.set("paperWidthMm", String(paperWidthMm));
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="領収書印字プレビュー"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Card padding="0">
          <TabGroupBar tabs={RECEIPT_TABS} />
        </Card>
        <Layout>
          {saved ? (
            <Layout.Section>
              <Banner tone="success">
                保存しました。プレビューは `/api/print/receipt/:id` と同一レンダラです。
              </Banner>
            </Layout.Section>
          ) : null}
          <Layout.Section>
            <Banner tone="info">
              詳細テンプレート編集は「領収書テンプレート」タブ。ここでは印字 HTML
              に効く主要項目だけを触り、見た目の一致を確認できます。注文／商品属性の ON/OFF は「販売レシート設定」と共通です。
            </Banner>
          </Layout.Section>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  印字に効く項目
                </Text>
                <TextField
                  label="タイトル"
                  value={form.receiptTitle || "領収書"}
                  onChange={(v) => setForm((p) => ({ ...p, receiptTitle: v }))}
                  autoComplete="off"
                />
                <TextField
                  label="発行者名"
                  value={form.companyName}
                  onChange={(v) => setForm((p) => ({ ...p, companyName: v }))}
                  autoComplete="off"
                />
                <TextField
                  label="住所"
                  value={form.address}
                  onChange={(v) => setForm((p) => ({ ...p, address: v }))}
                  autoComplete="off"
                />
                <TextField
                  label="電話"
                  value={form.phone}
                  onChange={(v) => setForm((p) => ({ ...p, phone: v }))}
                  autoComplete="off"
                />
                <TextField
                  label="但し書きデフォルト"
                  value={form.defaultProviso}
                  onChange={(v) => setForm((p) => ({ ...p, defaultProviso: v }))}
                  autoComplete="off"
                />
                <Checkbox
                  label="注文番号を印字"
                  checked={form.showOrderName}
                  onChange={(v) => setForm((p) => ({ ...p, showOrderName: v }))}
                />
                <Checkbox
                  label="発行日を印字"
                  checked={form.showIssueDate}
                  onChange={(v) => setForm((p) => ({ ...p, showIssueDate: v }))}
                />
                <Checkbox
                  label="店舗名を印字"
                  checked={form.showLocationName}
                  onChange={(v) => setForm((p) => ({ ...p, showLocationName: v }))}
                />
                <Select
                  label="用紙幅（印字設定と同期）"
                  options={[
                    { label: "80mm", value: "80" },
                    { label: "58mm", value: "58" },
                  ]}
                  value={String(paperWidthMm)}
                  onChange={(v) => setPaperWidthMm(v === "58" ? 58 : 80)}
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
                  印字 HTML プレビュー
                </Text>
                <Box
                  padding="300"
                  background="bg-surface-secondary"
                  borderRadius="200"
                  borderWidth="025"
                  borderColor="border"
                >
                  <iframe
                    title="receipt-print-preview"
                    srcDoc={previewHtml}
                    style={{ width: "100%", minHeight: 420, border: "none", background: "#fff" }}
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
