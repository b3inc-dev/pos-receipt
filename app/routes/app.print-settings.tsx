/**
 * /app/print-settings — 印字設定（要件 §12）
 * アプリ独自印字は Shopify Printing API に統一。旧方式は保存値の読み取りのみ。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit, useLocation, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
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
  SALES_RECEIPT_SETTINGS_KEY,
  type PrintSettings,
  type SalesReceiptSettings,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, RECEIPT_TABS } from "../components/TabGroupBar";
import { PaperWidthCorrespondence } from "../components/PaperWidthCorrespondence";
import { parseSalesPaperWidth, parseSharedPaperWidth } from "../utils/paperWidthCorrespondence";

const UNIFIED_PRINT_MODE = "shopify_printing" as const;

const PAPER_WIDTH_OPTIONS = [
  { label: "58mm", value: "58mm" },
  { label: "80mm", value: "80mm" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY);
  const settings: PrintSettings = { ...DEFAULT_PRINT_SETTINGS, ...saved };
  const sales = await getAppSetting<Partial<SalesReceiptSettings>>(shop.id, SALES_RECEIPT_SETTINGS_KEY);
  return {
    settings,
    storedDefaultPrintMode: saved?.defaultPrintMode ?? null,
    salesPaperWidthMm: parseSalesPaperWidth(sales?.paperWidthMm),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const str = (k: string, d: string) => String(formData.get(k) ?? d).trim();
  const bool = (k: string, def: boolean) => {
    const v = formData.get(k);
    return v === "true" || (def && v !== "false");
  };
  const existing =
    (await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {};
  const settings: PrintSettings = {
    ...DEFAULT_PRINT_SETTINGS,
    ...existing,
    defaultPrintMode: UNIFIED_PRINT_MODE,
    locationPrintModeOverrideEnabled: false,
    cloudprntPaperWidth: str("cloudprntPaperWidth", existing.cloudprntPaperWidth ?? "80mm"),
    cloudprntEnabled: false,
    createSettlementOrderWhenPrinting: false,
    attachSettlementNoteToOrder: false,
    attachSettlementMetafieldsToOrder: false,
    receiptPrintMode: UNIFIED_PRINT_MODE,
    receiptPreviewBeforePrintRequired: bool(
      "receiptPreviewBeforePrintRequired",
      existing.receiptPreviewBeforePrintRequired !== false,
    ),
    preferPrintingApi: true,
    settlementPrintingApiEnabled: true,
    receiptPrintingApiEnabled: true,
    cloudprntProfileName: str("cloudprntProfileName", existing.cloudprntProfileName ?? ""),
  };
  await setAppSetting(shop.id, PRINT_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function PrintSettingsPage() {
  const { settings: initial, storedDefaultPrintMode, salesPaperWidthMm } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<PrintSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    fd.set("cloudprntPaperWidth", form.cloudprntPaperWidth);
    fd.set(
      "receiptPreviewBeforePrintRequired",
      form.receiptPreviewBeforePrintRequired ? "true" : "false",
    );
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const legacyNote =
    storedDefaultPrintMode && storedDefaultPrintMode !== UNIFIED_PRINT_MODE
      ? `保存済みの旧 defaultPrintMode は「${storedDefaultPrintMode}」です。出力には使いません。`
      : null;

  return (
    <PolarisPageWrapper>
      <Page
        title="印字設定"
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
              精算・点検・領収書・販売レシートのアプリ独自印字は Shopify Printing API（shopify.printing）に統一しています。
              CloudPRNT ポーリングと精算注文経由の印字は選べません。通常の Shopify 販売注文の標準レシートは対象外です。
              POS 11.11+ とペアリング済みレシートプリンタ（HTML 直印字）が必要です。
            </Banner>
          </Layout.Section>

          <Layout.AnnotatedSection
            title="印字方式"
            description="実行時は常に Shopify Printing API。旧 Location.printMode は正規化のみ"
          >
            <Card>
              <BlockStack gap="400">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  Shopify Printing API（統一）
                </Text>
                <Text as="p" tone="subdued">
                  接続中（connected: true）のプリンタへ HTML を送ります。未接続を成功扱いしません。
                  システム印刷ダイアログを使う場合は直接印字成功と区別して表示します。
                  print() の完了は API 受付であり、紙の排出完了ではありません。
                </Text>
                {legacyNote ? <Banner>{legacyNote}</Banner> : null}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="用紙幅"
            description="精算・点検・領収書が使う幅です。販売レシートの幅は別の設定です。"
          >
            <Card>
              <BlockStack gap="400">
                <Select
                  label="レシート用紙幅"
                  options={PAPER_WIDTH_OPTIONS}
                  value={form.cloudprntPaperWidth}
                  onChange={(v) => set("cloudprntPaperWidth", v)}
                  helpText="精算・点検・領収書の HTML 幅です。販売レシートの幅は販売レシート設定です。"
                />
                <PaperWidthCorrespondence
                  sharedWidthMm={parseSharedPaperWidth(form.cloudprntPaperWidth)}
                  salesWidthMm={salesPaperWidthMm}
                  search={q}
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="領収書" description="§12.2.4">
            <Card>
              <BlockStack gap="400">
                <Checkbox
                  label="印字前にプレビュー必須"
                  checked={form.receiptPreviewBeforePrintRequired}
                  onChange={(v) => set("receiptPreviewBeforePrintRequired", v)}
                />
                <Text as="p" tone="subdued">
                  領収書も販売レシートと同じ shopify.printing です。旧 receiptPrintMode は出力に使いません。
                </Text>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="廃止した経路" description="管理画面から選べません。保存済みフラグは旧処理を復活させません">
            <Card>
              <BlockStack gap="300">
                <Text as="p">CloudPRNT 直印字（print-payload ポーリング）— 410 Gone</Text>
                <Text as="p">注文経由印字（SETTLEMENT / INSPECTION 注文の作成・更新・履行）— 呼び出しません</Text>
                <Text as="p">
                  「Printing API を有効化／優先」切替 — 常に Printing API。OFF 保存が残っていても旧経路は出ません。
                </Text>
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
