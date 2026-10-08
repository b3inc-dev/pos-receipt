/**
 * /app/settlement-print-layout — 精算／点検印字 HTML プレビュー（共通レンダラ）
 * 専用フルエディタではなく、主要 ON/OFF + プレビュー＝印字 HTML 一致を担保する。
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
  Box,
} from "@shopify/polaris";
import { useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  getAppSetting,
  setAppSetting,
  PRINT_SETTINGS_KEY,
  DEFAULT_PRINT_SETTINGS,
  type PrintSettings,
} from "../utils/appSettings.server";
import {
  renderPrintReceiptHtml,
  settlementPreviewToPrintModel,
} from "../services/printReceiptHtml";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";

const PREVIEW_KEY = "settlement_print_layout_preview";

type SettlementPreviewPrefs = {
  isInspection: boolean;
  showVoucherChange: boolean;
  paperWidthMm: 58 | 80;
};

const DEFAULT_PREFS: SettlementPreviewPrefs = {
  isInspection: false,
  showVoucherChange: true,
  paperWidthMm: 80,
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const printSettings = {
    ...DEFAULT_PRINT_SETTINGS,
    ...((await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {}),
  };
  const saved =
    (await getAppSetting<Partial<SettlementPreviewPrefs>>(shop.id, PREVIEW_KEY)) ?? {};
  const paperFromPrint =
    printSettings.cloudprntPaperWidth === "58mm" ? (58 as const) : (80 as const);
  const prefs: SettlementPreviewPrefs = {
    ...DEFAULT_PREFS,
    paperWidthMm: paperFromPrint,
    ...saved,
  };
  return { prefs, printSettings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const prefs: SettlementPreviewPrefs = {
    isInspection: formData.get("isInspection") === "true",
    showVoucherChange: formData.get("showVoucherChange") === "true",
    paperWidthMm: formData.get("paperWidthMm") === "58" ? 58 : 80,
  };
  await setAppSetting(shop.id, PREVIEW_KEY, prefs);

  // 用紙幅は印字設定にも反映（精算 HTML 経路が参照）
  const printSettings = {
    ...DEFAULT_PRINT_SETTINGS,
    ...((await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {}),
    cloudprntPaperWidth: prefs.paperWidthMm === 58 ? "58mm" : "80mm",
  };
  await setAppSetting(shop.id, PRINT_SETTINGS_KEY, printSettings);
  return Response.json({ ok: true });
}

function buildPreviewHtml(prefs: SettlementPreviewPrefs): string {
  return renderPrintReceiptHtml(
    settlementPreviewToPrintModel(
      {
        targetDate: "2026-10-08",
        locationName: "渋谷店",
        currency: "JPY",
        total: 125000,
        netSales: 113636,
        tax: 11364,
        discounts: 2000,
        refundTotal: 3000,
        orderCount: 42,
        refundCount: 2,
        itemCount: 87,
        voucherChangeAmount: prefs.showVoucherChange ? 500 : 0,
        paymentSections: [
          { label: "現金", net: 45000, txCount: 18, refund: 0, refundCount: 0 },
          { label: "クレジットカード", net: 80000, txCount: 24, refund: 3000, refundCount: 2 },
        ],
      },
      { isInspection: prefs.isInspection, paperWidthMm: prefs.paperWidthMm },
    ),
  );
}

export default function SettlementPrintLayoutPage() {
  const { prefs: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState(initial);
  const previewHtml = useMemo(() => buildPreviewHtml(form), [form]);

  const handleSave = () => {
    const fd = new FormData();
    fd.set("isInspection", form.isInspection ? "true" : "false");
    fd.set("showVoucherChange", form.showVoucherChange ? "true" : "false");
    fd.set("paperWidthMm", String(form.paperWidthMm));
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="精算印字プレビュー"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Card padding="0">
          <TabGroupBar tabs={SETTLEMENT_TABS} />
        </Card>
        <Layout>
          {saved ? (
            <Layout.Section>
              <Banner tone="success">保存しました。プレビューは印字 HTML と同一レンダラです。</Banner>
            </Layout.Section>
          ) : null}
          <Layout.Section>
            <Banner tone="info">
              `/api/print/settlement/:id` と同じ `renderPrintReceiptHtml` /
              `settlementPreviewToPrintModel` を使います。用紙幅は印字設定にも反映されます。旧
              order_based / cloudprnt 経路は変更しません。
            </Banner>
          </Layout.Section>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  表示オプション
                </Text>
                <Checkbox
                  label="点検レシートとしてプレビュー"
                  checked={form.isInspection}
                  onChange={(v) => setForm((p) => ({ ...p, isInspection: v }))}
                />
                <Checkbox
                  label="商品券釣有り差額行を含める"
                  checked={form.showVoucherChange}
                  onChange={(v) => setForm((p) => ({ ...p, showVoucherChange: v }))}
                />
                <Select
                  label="用紙幅（印字設定と同期）"
                  options={[
                    { label: "80mm", value: "80" },
                    { label: "58mm", value: "58" },
                  ]}
                  value={String(form.paperWidthMm)}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, paperWidthMm: v === "58" ? 58 : 80 }))
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
                    title="settlement-print-preview"
                    srcDoc={previewHtml}
                    style={{ width: "100%", minHeight: 480, border: "none", background: "#fff" }}
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
