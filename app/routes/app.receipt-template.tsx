/**
 * /app/receipt-template — 領収書テンプレート編集ページ
 * 要件書 §9 領収書設定: §9.2 全項目対応・プレビュー一致（§9.3）
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
  Box,
  Divider,
  InlineStack,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  DEFAULT_TEMPLATE,
  normalizeTemplateData,
  type ReceiptTemplateData,
} from "./api.settings.receipt-template";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { useState } from "react";

function formDataToTemplate(formData: FormData): ReceiptTemplateData {
  const get = (k: string) => formData.get(k);
  const getStr = (k: string, def = "") => String(get(k) ?? def).trim();
  const getBool = (k: string, def = true) => get(k) === "true" || (def && get(k) !== "false");
  const data: ReceiptTemplateData = {
    ...DEFAULT_TEMPLATE,
    receiptTemplateName: getStr("receiptTemplateName"),
    logoUrl: getStr("logoUrl") || null,
    companyName: getStr("companyName"),
    postalCode: getStr("postalCode"),
    address: getStr("address"),
    address2: getStr("address2"),
    phone: getStr("phone"),
    showIssueDate: getBool("showIssueDate"),
    showOrderName: getBool("showOrderName"),
    showLocationName: getBool("showLocationName"),
    showCustomerName: getBool("showCustomerName"),
    showProviso: getBool("showProviso"),
    showAmount: getBool("showAmount"),
    showTaxNote: getBool("showTaxNote"),
    showReissueMark: getBool("showReissueMark"),
    defaultProviso: getStr("defaultProviso", "お買上品代として"),
    defaultRecipientSuffix: getStr("defaultRecipientSuffix", "様"),
    headerAlignment: (getStr("headerAlignment") || "center") as "left" | "center" | "right",
    logoPosition: (getStr("logoPosition") || "top") as "top" | "inline",
    companyInfoPosition: (getStr("companyInfoPosition") || "bottom") as "top" | "bottom",
    amountEmphasisMode: (getStr("amountEmphasisMode") || "normal") as "normal" | "emphasis",
    bodySpacing: (getStr("bodySpacing") || "normal") as "compact" | "normal" | "relaxed",
    receiptTitle: getStr("receiptTitle", "領収書"),
    reissueLabel: getStr("reissueLabel", "再発行"),
    taxNoteLabel: getStr("taxNoteLabel", "（税込）"),
    currencyPrefix: getStr("currencyPrefix", "¥"),
  };
  data.showOrderNumber = data.showOrderName;
  data.showDate = data.showIssueDate;
  return data;
}

function templateToFormData(form: ReceiptTemplateData): FormData {
  const fd = new FormData();
  fd.set("receiptTemplateName", form.receiptTemplateName);
  fd.set("logoUrl", form.logoUrl ?? "");
  fd.set("companyName", form.companyName);
  fd.set("postalCode", form.postalCode);
  fd.set("address", form.address);
  fd.set("address2", form.address2);
  fd.set("phone", form.phone);
  fd.set("showIssueDate", form.showIssueDate ? "true" : "false");
  fd.set("showOrderName", form.showOrderName ? "true" : "false");
  fd.set("showLocationName", form.showLocationName ? "true" : "false");
  fd.set("showCustomerName", form.showCustomerName ? "true" : "false");
  fd.set("showProviso", form.showProviso ? "true" : "false");
  fd.set("showAmount", form.showAmount ? "true" : "false");
  fd.set("showTaxNote", form.showTaxNote ? "true" : "false");
  fd.set("showReissueMark", form.showReissueMark ? "true" : "false");
  fd.set("defaultProviso", form.defaultProviso);
  fd.set("defaultRecipientSuffix", form.defaultRecipientSuffix);
  fd.set("headerAlignment", form.headerAlignment);
  fd.set("logoPosition", form.logoPosition);
  fd.set("companyInfoPosition", form.companyInfoPosition);
  fd.set("amountEmphasisMode", form.amountEmphasisMode);
  fd.set("bodySpacing", form.bodySpacing);
  fd.set("receiptTitle", form.receiptTitle);
  fd.set("reissueLabel", form.reissueLabel);
  fd.set("taxNoteLabel", form.taxNoteLabel);
  fd.set("currencyPrefix", form.currencyPrefix);
  return fd;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const tmpl = await prisma.receiptTemplate.findFirst({
    where: { shopId: shop.id, isActive: true },
    orderBy: { updatedAt: "desc" },
  });

  const data = tmpl
    ? normalizeTemplateData(JSON.parse(tmpl.templateJson) as Record<string, unknown>)
    : { ...DEFAULT_TEMPLATE };

  return { template: data, version: tmpl?.version ?? 1 };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const formData = await request.formData();
  const data = formDataToTemplate(formData);

  const existing = await prisma.receiptTemplate.findFirst({
    where: { shopId: shop.id, isActive: true },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) {
    await prisma.receiptTemplate.update({
      where: { id: existing.id },
      data: {
        templateJson: JSON.stringify(data),
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });
  } else {
    await prisma.receiptTemplate.create({
      data: {
        shopId: shop.id,
        name: data.receiptTemplateName || "デフォルトテンプレート",
        isActive: true,
        templateJson: JSON.stringify(data),
        version: 1,
      },
    });
  }

  return Response.json({ ok: true });
}

const HEADER_ALIGN_OPTIONS = [
  { label: "左", value: "left" },
  { label: "中央", value: "center" },
  { label: "右", value: "right" },
];
const LOGO_POS_OPTIONS = [
  { label: "上部", value: "top" },
  { label: "インライン", value: "inline" },
];
const COMPANY_POS_OPTIONS = [
  { label: "上部", value: "top" },
  { label: "下部", value: "bottom" },
];
const BODY_SPACING_OPTIONS = [
  { label: "詰める", value: "compact" },
  { label: "標準", value: "normal" },
  { label: "ゆったり", value: "relaxed" },
];

export default function ReceiptTemplatePage() {
  const { template, version } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<ReceiptTemplateData>({ ...template });

  const handleSave = () => {
    submit(templateToFormData(form), { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = (key: keyof ReceiptTemplateData, value: string | boolean | null) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="領収書テンプレート設定"
        backAction={{ content: "戻る", onAction: () => navigate("/app/settings" + q) }}
        subtitle={`バージョン: ${version}`}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Layout>
          {saved && (
            <Layout.Section>
              <Banner tone="success">保存しました。</Banner>
            </Layout.Section>
          )}

          {/* §9.2.1 基本情報 */}
          <Layout.AnnotatedSection
            title="基本情報"
            description="テンプレート名・ロゴ・発行者（会社）情報。領収書のフッターに表示されます。"
          >
            <Card>
              <BlockStack gap="400">
                <TextField
                  label="テンプレート名"
                  value={form.receiptTemplateName}
                  onChange={(v) => set("receiptTemplateName", v)}
                  placeholder="デフォルトテンプレート"
                  autoComplete="off"
                />
                <TextField
                  label="ロゴ画像URL（任意）"
                  value={form.logoUrl ?? ""}
                  onChange={(v) => set("logoUrl", v || null)}
                  helpText="https://... で始まる画像URL"
                  autoComplete="off"
                />
                <TextField
                  label="会社名・店舗名"
                  value={form.companyName}
                  onChange={(v) => set("companyName", v)}
                  autoComplete="off"
                />
                <TextField
                  label="郵便番号"
                  value={form.postalCode}
                  onChange={(v) => set("postalCode", v)}
                  autoComplete="off"
                />
                <TextField
                  label="住所1"
                  value={form.address}
                  onChange={(v) => set("address", v)}
                  autoComplete="off"
                />
                <TextField
                  label="住所2（建物名等）"
                  value={form.address2}
                  onChange={(v) => set("address2", v)}
                  autoComplete="off"
                />
                <TextField
                  label="電話番号"
                  value={form.phone}
                  onChange={(v) => set("phone", v)}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {/* §9.2.2 表示項目 */}
          <Layout.AnnotatedSection
            title="表示項目"
            description="領収書に表示する項目のON/OFFを設定します。"
          >
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="400" wrap>
                  <Checkbox
                    label="発行日"
                    checked={form.showIssueDate}
                    onChange={(v) => set("showIssueDate", v)}
                  />
                  <Checkbox
                    label="注文番号"
                    checked={form.showOrderName}
                    onChange={(v) => set("showOrderName", v)}
                  />
                  <Checkbox
                    label="ロケーション名"
                    checked={form.showLocationName}
                    onChange={(v) => set("showLocationName", v)}
                  />
                  <Checkbox
                    label="宛名（顧客名）"
                    checked={form.showCustomerName}
                    onChange={(v) => set("showCustomerName", v)}
                  />
                  <Checkbox
                    label="但し書き"
                    checked={form.showProviso}
                    onChange={(v) => set("showProviso", v)}
                  />
                  <Checkbox
                    label="金額"
                    checked={form.showAmount}
                    onChange={(v) => set("showAmount", v)}
                  />
                  <Checkbox
                    label="税注記"
                    checked={form.showTaxNote}
                    onChange={(v) => set("showTaxNote", v)}
                  />
                  <Checkbox
                    label="再発行マーク"
                    checked={form.showReissueMark}
                    onChange={(v) => set("showReissueMark", v)}
                  />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {/* §9.2.3 デフォルト値 */}
          <Layout.AnnotatedSection
            title="デフォルト値"
            description="但し書きと宛名のデフォルト表記。"
          >
            <Card>
              <BlockStack gap="400">
                <TextField
                  label="但し書きデフォルト"
                  value={form.defaultProviso}
                  onChange={(v) => set("defaultProviso", v)}
                  helpText="発行時に入力が空のときに使用"
                  autoComplete="off"
                />
                <TextField
                  label="宛名の後ろに付ける文字"
                  value={form.defaultRecipientSuffix}
                  onChange={(v) => set("defaultRecipientSuffix", v)}
                  helpText="例: 様"
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {/* §9.2.4 レイアウト・§9.2.5 文言 */}
          <Layout.AnnotatedSection
            title="レイアウト・文言"
            description="見出しの揃え、タイトル・ラベルの文言を設定します。"
          >
            <Card>
              <BlockStack gap="400">
                <Select
                  label="見出しの揃え"
                  options={HEADER_ALIGN_OPTIONS}
                  value={form.headerAlignment}
                  onChange={(v) => set("headerAlignment", v as "left" | "center" | "right")}
                />
                <Select
                  label="ロゴの位置"
                  options={LOGO_POS_OPTIONS}
                  value={form.logoPosition}
                  onChange={(v) => set("logoPosition", v as "top" | "inline")}
                />
                <Select
                  label="会社情報の位置"
                  options={COMPANY_POS_OPTIONS}
                  value={form.companyInfoPosition}
                  onChange={(v) => set("companyInfoPosition", v as "top" | "bottom")}
                />
                <Select
                  label="本文の間隔"
                  options={BODY_SPACING_OPTIONS}
                  value={form.bodySpacing}
                  onChange={(v) => set("bodySpacing", v as "compact" | "normal" | "relaxed")}
                />
                <TextField
                  label="領収書タイトル"
                  value={form.receiptTitle}
                  onChange={(v) => set("receiptTitle", v)}
                  autoComplete="off"
                />
                <TextField
                  label="再発行時のラベル"
                  value={form.reissueLabel}
                  onChange={(v) => set("reissueLabel", v)}
                  autoComplete="off"
                />
                <TextField
                  label="税注記の文言"
                  value={form.taxNoteLabel}
                  onChange={(v) => set("taxNoteLabel", v)}
                  autoComplete="off"
                />
                <TextField
                  label="通貨プレフィックス"
                  value={form.currencyPrefix}
                  onChange={(v) => set("currencyPrefix", v)}
                  helpText="例: ¥"
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {/* §9.3 プレビュー（保存前・保存後で同じ表示になるよう同一ロジック） */}
          <Layout.AnnotatedSection
            title="プレビュー"
            description="現在の設定で発行される領収書のイメージです。保存後も同じ内容で表示されます。"
          >
            <Card>
              <ReceiptPreview template={form} />
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

/** 設定に従い領収書プレビューを描画（§9.3: 実際の印字レイアウトと一致） */
function ReceiptPreview({ template }: { template: ReceiptTemplateData }) {
  const today = new Date().toLocaleDateString("ja-JP");
  const alignment = template.headerAlignment === "right" ? "end" : template.headerAlignment === "left" ? "start" : "center";
  const amountText = template.showAmount
    ? `${template.currencyPrefix} 10,000${template.showTaxNote ? ` ${template.taxNoteLabel}` : ""}`
    : "";

  const companyBlock = (
    <>
      <Text as="p">{template.companyName || "（会社名未設定）"}</Text>
      {template.postalCode && <Text tone="subdued" as="p">〒 {template.postalCode}</Text>}
      {(template.address || template.address2) && (
        <Text tone="subdued" as="p">
          {[template.address, template.address2].filter(Boolean).join(" ")}
        </Text>
      )}
      {template.phone && <Text tone="subdued" as="p">TEL: {template.phone}</Text>}
    </>
  );

  return (
    <Box padding="400" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap={template.bodySpacing === "compact" ? "100" : template.bodySpacing === "relaxed" ? "300" : "200"}>
        {template.logoUrl && template.logoPosition === "top" && (
          <Box paddingBlockEnd="200">
            <img src={template.logoUrl} alt="ロゴ" style={{ maxHeight: 60 }} />
          </Box>
        )}
        {template.companyInfoPosition === "top" && companyBlock}
        <Text variant="headingMd" as="p" alignment={alignment}>
          {template.receiptTitle}
        </Text>
        {template.showReissueMark && (
          <Text as="p" alignment={alignment} tone="critical">
            【{template.reissueLabel}】
          </Text>
        )}
        {amountText && (
          <Text
            as="p"
            alignment={alignment}
            fontWeight={template.amountEmphasisMode === "emphasis" ? "bold" : "regular"}
          >
            {amountText}
          </Text>
        )}
        <Text as="p" alignment={alignment} tone="subdued">
          上記の金額を確かに領収いたしました
        </Text>
        <Divider />
        {template.showProviso && (
          <Text as="p">但し: {template.defaultProviso}</Text>
        )}
        {template.showIssueDate && <Text as="p">発行日: {today}</Text>}
        {template.showOrderName && <Text as="p">注文番号: #1001</Text>}
        {template.showLocationName && <Text as="p">ロケーション: 本店</Text>}
        {template.showCustomerName && (
          <Text as="p">宛名: 山田太郎{template.defaultRecipientSuffix}</Text>
        )}
        <Divider />
        {template.companyInfoPosition === "bottom" && companyBlock}
      </BlockStack>
    </Box>
  );
}
