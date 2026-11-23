/**
 * /app/sales-receipt-layout — ビジュアル編集（販売レシート主）
 * プレビュー HTML は印字と同じ renderPrintReceiptHtml を使用。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useSubmit, useLocation, useNavigate, useNavigation } from "react-router";
import { SuccessToast, AdminIntro } from "../components/admin-ui";
import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Checkbox,
  BlockStack,
  Banner,
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
import { DEFAULT_GIFT_LAYOUT, GIFT_LAYOUT_KEY, type GiftLayout } from "../utils/salesReceiptSettings";
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
  const giftLayout = await getAppSetting<GiftLayout>(shop.id, GIFT_LAYOUT_KEY);
  return { settings, giftLayout: giftLayout ?? DEFAULT_GIFT_LAYOUT };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const bool = (k: string) => get(k) === "true";
  const str = (k: string, d: string) => String(get(k) ?? d);
  // 1 回の保存で販売レシートとギフトレシートの両方を保存する（UI ルール v1.1: 保存は 1 画面に 1 つ）。
  // ギフトの欄が正しくなければ、どちらも保存しない
  const giftTitle = str("giftTitle", "").trim();
  const giftFooter = str("giftFooter", "");
  if (!giftTitle || giftTitle.length > 80 || giftFooter.length > 500) {
    return Response.json(
      { ok: false, error: "ギフトレシートの見出しは1〜80文字、末尾文は500文字以内で入力してください。" },
      { status: 400 },
    );
  }
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
  await setAppSetting(shop.id, GIFT_LAYOUT_KEY, {
    title: giftTitle,
    footer: giftFooter,
    showOrderNumber: bool("giftShowOrderNumber"),
  });
  return Response.json({ ok: true, at: Date.now() });
}

function buildSampleHtml(settings: SalesReceiptSettings, gift: boolean, layout: GiftLayout): string {
  if (gift) {
    return renderPrintReceiptHtml({
      kind: "gift", layout, orderName: "#1042", paperWidthMm: settings.paperWidthMm,
      items: [{ name: "サンプル商品 A（M / 黒）", quantity: 1 }, { name: "サンプル商品 B", quantity: 2 }],
    });
  }
  // 実印字（buildSalesReceiptPrintModel）と同じく layoutJson フラグで描画制御する
  return renderPrintReceiptHtml({
    kind: "sales",
    shopName: settings.headerTitle || "レシート",
    orderName: "#1042",
    createdAtLabel: "2026/10/08 13:45",
    locationName: "渋谷店",
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
        sku: "SKU-A",
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
        sku: "SKU-B",
        customAttributes: [],
      },
    ],
    orderAttributes: settings.printOrderAttributes
      ? [
          { key: "来店目的", value: "ギフト" },
          { key: "スタッフメモ", value: "袋不要" },
        ]
      : [],
    payments: [
      { label: "現金", amount: 2000 },
      { label: "クレジットカード", amount: 1400 },
    ],
    footerNote: settings.footerNote,
    showOrderAttributes: settings.printOrderAttributes,
    showLineAttributes: settings.printLineAttributes,
    showSku: !!settings.layoutJson.showSku,
    showPayments: settings.layoutJson.showPayments !== false,
    showLocation: settings.layoutJson.showLocation !== false,
    paperWidthMm: settings.paperWidthMm,
  });
}

export default function SalesReceiptLayoutPage() {
  const { settings: initial, giftLayout: initialGift } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const actionData = useActionData<{ ok?: boolean; error?: string; at?: number }>();
  const navigation = useNavigation();
  // 押してから終わるまで保存ボタンを処理中にし、二重に押せないようにする（UI ルール v1.1）
  const saving = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [form, setForm] = useState(initial);

  const [gift, setGift] = useState(false);
  const [giftLayout, setGiftLayout] = useState(initialGift);
  const previewHtml = useMemo(() => buildSampleHtml(form, gift, giftLayout), [form, gift, giftLayout]);

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
    fd.set("giftTitle", giftLayout.title);
    fd.set("giftFooter", giftLayout.footer);
    fd.set("giftShowOrderNumber", giftLayout.showOrderNumber ? "true" : "false");
    submit(fd, { method: "post" });
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="販売レイアウト編集"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
        primaryAction={{
          content: saving ? "処理中…" : "保存",
          onAction: handleSave,
          loading: saving,
          disabled: saving,
        }}
      >
        <Card padding="0">
          <TabGroupBar tabs={RECEIPT_TABS} />
        </Card>
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
            <AdminIntro><p>販売レシートとギフトレシートの見た目を選びます。プレビューは印字と同じ作りで、保存すると次の印字から変わります。</p></AdminIntro>
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
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  印字プレビュー
                </Text>
                <Checkbox label="ギフトレシートをプレビュー（金額なし）" checked={gift} onChange={setGift} />
                {gift && (
                  <BlockStack gap="200">
                    <TextField label="ギフトの見出し" value={giftLayout.title} maxLength={80} autoComplete="off"
                      onChange={(title) => setGiftLayout((prev) => ({ ...prev, title }))} />
                    <TextField label="ギフトの末尾文" value={giftLayout.footer} maxLength={500} multiline={2} autoComplete="off"
                      onChange={(footer) => setGiftLayout((prev) => ({ ...prev, footer }))} />
                    <Checkbox label="ギフトに注文番号を表示" checked={giftLayout.showOrderNumber}
                      onChange={(showOrderNumber) => setGiftLayout((prev) => ({ ...prev, showOrderNumber }))} />
                    <Text as="p" tone="subdued">ギフトレシートの設定も、上の「保存」で一緒に保存します。</Text>
                  </BlockStack>
                )}
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
