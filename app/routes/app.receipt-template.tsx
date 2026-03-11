/**
 * /app/receipt-template — 領収書テンプレート編集ページ
 * 要件書 §8.3–§8.4 / §19.3 管理画面: 領収書テンプレート
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { DEFAULT_TEMPLATE, type ReceiptTemplateData } from "./api.settings.receipt-template";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { useState } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const tmpl = await prisma.receiptTemplate.findFirst({
    where: { shopId: shop.id, isActive: true },
    orderBy: { updatedAt: "desc" },
  });

  const data: ReceiptTemplateData = {
    ...DEFAULT_TEMPLATE,
    ...(tmpl ? (JSON.parse(tmpl.templateJson) as Partial<ReceiptTemplateData>) : {}),
  };

  return { template: data, version: tmpl?.version ?? 1 };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const formData = await request.formData();
  const data: ReceiptTemplateData = {
    companyName: String(formData.get("companyName") ?? ""),
    address: String(formData.get("address") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    defaultProviso: String(formData.get("defaultProviso") ?? "お買上品代として"),
    showOrderNumber: formData.get("showOrderNumber") === "true",
    showDate: formData.get("showDate") === "true",
    logoUrl: formData.get("logoUrl") ? String(formData.get("logoUrl")) : null,
  };

  // 既存テンプレートを更新（バージョンインクリメント）
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
        name: "デフォルトテンプレート",
        isActive: true,
        templateJson: JSON.stringify(data),
        version: 1,
      },
    });
  }

  return Response.json({ ok: true });
}

export default function ReceiptTemplatePage() {
  const { template, version } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<ReceiptTemplateData>({ ...template });

  const handleSave = () => {
    const fd = new FormData();
    fd.set("companyName", form.companyName);
    fd.set("address", form.address);
    fd.set("phone", form.phone);
    fd.set("defaultProviso", form.defaultProviso);
    fd.set("showOrderNumber", String(form.showOrderNumber));
    fd.set("showDate", String(form.showDate));
    fd.set("logoUrl", form.logoUrl ?? "");
    submit(fd, { method: "post" });
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

        {/* ── 発行者情報 ── */}
        <Layout.AnnotatedSection
          title="発行者情報"
          description="領収書に印字される会社名・住所・電話番号を設定します。これらは発行された領収書のフッターに表示されます。"
        >
          <Card>
            <BlockStack gap="400">
              <TextField
                label="会社名・店舗名"
                value={form.companyName}
                onChange={(v) => set("companyName", v)}
                autoComplete="off"
              />
              <TextField
                label="住所"
                value={form.address}
                onChange={(v) => set("address", v)}
                autoComplete="off"
              />
              <TextField
                label="電話番号"
                value={form.phone}
                onChange={(v) => set("phone", v)}
                autoComplete="off"
              />
              <TextField
                label="ロゴ画像URL（任意）"
                value={form.logoUrl ?? ""}
                onChange={(v) => set("logoUrl", v || null)}
                helpText="https://... で始まる画像URLを入力してください"
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── 印字設定 ── */}
        <Layout.AnnotatedSection
          title="印字設定"
          description="但し書きのデフォルト値と各種印字オプションを設定します。但し書きは発行時に変更することもできます。"
        >
          <Card>
            <BlockStack gap="400">
              <TextField
                label="但し書きデフォルト値"
                value={form.defaultProviso}
                onChange={(v) => set("defaultProviso", v)}
                helpText="発行時に但し書きが空のときに使用されます"
                autoComplete="off"
              />
              <Checkbox
                label="注文番号を印字する"
                checked={form.showOrderNumber}
                onChange={(v) => set("showOrderNumber", v)}
              />
              <Checkbox
                label="発行日を印字する"
                checked={form.showDate}
                onChange={(v) => set("showDate", v)}
              />
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── プレビュー ── */}
        <Layout.AnnotatedSection
          title="プレビュー"
          description="現在の設定で発行される領収書のイメージです。実際の印字内容はプリンター設定によって異なる場合があります。"
        >
          <Card>
            <ReceiptPreview template={form} />
          </Card>
        </Layout.AnnotatedSection>

        {/* ── 保存ボタン ── */}
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

function ReceiptPreview({ template }: { template: ReceiptTemplateData }) {
  const today = new Date().toLocaleDateString("ja-JP");
  return (
    <Box
      padding="400"
      background="bg-surface-secondary"
      borderRadius="200"
    >
      <BlockStack gap="100">
        {template.logoUrl && (
          <Box paddingBlockEnd="200">
            <img src={template.logoUrl} alt="ロゴ" style={{ maxHeight: 60 }} />
          </Box>
        )}
        <Text variant="headingMd" as="p" alignment="center">領 収 書</Text>
        <Text as="p" alignment="center">¥ 10,000</Text>
        <Text as="p" alignment="center">上記の金額を確かに領収いたしました</Text>
        <Divider />
        <Text as="p">但し: {template.defaultProviso}</Text>
        {template.showDate && <Text as="p">発行日: {today}</Text>}
        {template.showOrderNumber && <Text as="p">注文番号: #1001</Text>}
        <Divider />
        <Text as="p">{template.companyName || "（会社名未設定）"}</Text>
        {template.address && <Text tone="subdued" as="p">{template.address}</Text>}
        {template.phone && <Text tone="subdued" as="p">TEL: {template.phone}</Text>}
      </BlockStack>
    </Box>
  );
}
