import { ReceiptPrinterSettings } from "../components/ReceiptPrinterSettings";
import { normalizePrinterProfile } from "../services/receiptPrinterProfile";
/**
 * /app/print-settings — 印字設定（要件 §12）
 * アプリ独自印字は Shopify Printing API に統一。旧方式は保存値の読み取りのみ。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useSubmit, useLocation, useNavigate, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Checkbox,
  BlockStack,
  Banner,
  Select,
  TextField,
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
import {
  resolvePrintPaperWidthMm,
  syncPrintPaperWidthFields,
} from "../utils/printPaperWidth";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { SuccessToast } from "../components/admin-ui";
import { TabGroupBar, RECEIPT_TABS } from "../components/TabGroupBar";
import { PaperWidthCorrespondence } from "../components/PaperWidthCorrespondence";
import { parseSalesPaperWidth, parseSharedPaperWidth } from "../utils/paperWidthCorrespondence";
import {
  DEFAULT_REPRINT_MARK_TEXT,
  DEFAULT_RESETTLEMENT_MARK_TEXT,
  normalizePrintMarkSettings,
  PRINT_MARK_SETTINGS_KEY,
  PRINT_MARK_TEXT_MAX,
  type PrintMarkSettings,
} from "../services/printMarks";

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
  const marks = normalizePrintMarkSettings(await getAppSetting<unknown>(shop.id, PRINT_MARK_SETTINGS_KEY));
  return {
    settings,
    marks,
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
    receiptPrinterProfile: normalizePrinterProfile(formData.get("receiptPrinterProfile") ?? existing.receiptPrinterProfile),
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
  // 用紙幅: 中立 paperWidthMm とレガシー cloudprntPaperWidth を同期
  const widthRaw = str("paperWidthMm", str("cloudprntPaperWidth", "80mm"));
  const widthMm: 58 | 80 =
    widthRaw === "58" || widthRaw === "58mm" ? 58 : 80;
  Object.assign(settings, syncPrintPaperWidthFields(widthMm));
  await setAppSetting(shop.id, PRINT_SETTINGS_KEY, settings);
  // 再印字・再精算の印（別のキーに保存。読み込みで文言を整える）
  await setAppSetting(
    shop.id,
    PRINT_MARK_SETTINGS_KEY,
    normalizePrintMarkSettings({
      settlementReprint: formData.get("markSettlementReprint") === "true",
      receiptReprint: formData.get("markReceiptReprint") === "true",
      salesReprint: formData.get("markSalesReprint") === "true",
      resettlement: formData.get("markResettlement") === "true",
      reprintText: formData.get("markReprintText"),
      resettlementText: formData.get("markResettlementText"),
    }),
  );
  return Response.json({ ok: true, at: Date.now() });
}

export default function PrintSettingsPage() {
  const { settings: initial, marks: initialMarks, storedDefaultPrintMode, salesPaperWidthMm } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const actionData = useActionData<{ ok: boolean; at?: number }>();
  const q = location.search || "";
  const [form, setForm] = useState<PrintSettings>({ ...initial });
  const [marks, setMarks] = useState<PrintMarkSettings>({ ...initialMarks });
  const setMark = <K extends keyof PrintMarkSettings>(key: K, value: PrintMarkSettings[K]) => {
    setMarks((prev) => ({ ...prev, [key]: value }));
  };
  const anyReprint = marks.settlementReprint || marks.receiptReprint || marks.salesReprint;
  // 押してから終わるまで保存ボタンを処理中にし、二重に押せないようにする（UI ルール v1.1）
  const saving = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";

  const handleSave = () => {
    const fd = new FormData();
    fd.set("receiptPrinterProfile", normalizePrinterProfile(form.receiptPrinterProfile));
    fd.set("cloudprntPaperWidth", form.cloudprntPaperWidth);
    fd.set(
      "receiptPreviewBeforePrintRequired",
      form.receiptPreviewBeforePrintRequired ? "true" : "false",
    );
    fd.set("markSettlementReprint", marks.settlementReprint ? "true" : "false");
    fd.set("markReceiptReprint", marks.receiptReprint ? "true" : "false");
    fd.set("markSalesReprint", marks.salesReprint ? "true" : "false");
    fd.set("markResettlement", marks.resettlement ? "true" : "false");
    fd.set("markReprintText", marks.reprintText);
    fd.set("markResettlementText", marks.resettlementText);
    submit(fd, { method: "post" });
  };

  const set = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // 前の版で別の印字のやり方を選んでいた店にだけ出す（いまは使っていないことを知らせる）
  const hasLegacyMode = Boolean(storedDefaultPrintMode && storedDefaultPrintMode !== UNIFIED_PRINT_MODE);

  return (
    <PolarisPageWrapper>
      <Page
        title="印字設定"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
        primaryAction={{
          content: saving ? "処理中…" : "保存",
          onAction: handleSave,
          loading: saving,
          disabled: saving,
        }}
      >
        <TabGroupBar tabs={RECEIPT_TABS} />
        <Layout>
          {/* 保存できたかはトーストで、保存のたびに出す（UI ルール v1.1 7章） */}
          <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
          {/* お知らせ枠は 1 画面に 1 つ（UI ルール v1.1） */}
          <Layout.Section>
            <Banner tone="info">
              精算・点検・領収書・販売レシートは、POS につないだレシートプリンタで印刷します（Shopify POS 11.11 以上）。
              ふつうの販売のレシート（Shopify の標準のレシート）はこの設定の対象外です。
              {hasLegacyMode ? " 前の版で選んでいた印字のやり方は、いまは使っていません。" : ""}
            </Banner>
          </Layout.Section>

          <Layout.AnnotatedSection
            title="印字のやり方"
            description="選ぶ設定はありません。POS につないだプリンタへ直接送ります。"
          >
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  POS につないだレシートプリンタへ直接送る
                </Text>
                <Text as="p" tone="subdued">
                  プリンタがつながっていないときは、印字できなかったと POS に出します。
                  POS で「印字しました」と出ても、紙が出たかはプリンタで確かめてください。
                </Text>
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
                  helpText="精算・点検・領収書の幅です。販売レシートの幅は販売レシート設定で選びます。"
                />
                <PaperWidthCorrespondence
                  sharedWidthMm={parseSharedPaperWidth(form.cloudprntPaperWidth)}
                  salesWidthMm={salesPaperWidthMm}
                  search={q}
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="プリンターに合わせる" description="全帳票の58mm印字とレイアウトのプレビューで共通の設定です。80mmには適用しません。">
            <ReceiptPrinterSettings value={normalizePrinterProfile(form.receiptPrinterProfile)} onChange={(v) => set("receiptPrinterProfile", v)} />
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="再印字・再精算の印"
            description="ブランドや商業施設の決まりで、印刷し直した控えや確定し直した精算を見分けたいときに使います。印はレシートのいちばん上に四角で囲んで出します。"
          >
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">印刷し直したとき「再印字」と出すレシート</Text>
                  <Text as="p" tone="subdued">
                    一度印刷したあとにもう一度印刷すると出ます。発行した画面で押し直したときも、履歴から印刷したときも同じです。
                  </Text>
                  <Checkbox
                    label="精算レシート"
                    checked={marks.settlementReprint}
                    onChange={(v) => setMark("settlementReprint", v)}
                    helpText="点検レシートは確認のために何度も出すので、印は出しません。"
                  />
                  <Checkbox
                    label="領収書"
                    checked={marks.receiptReprint}
                    onChange={(v) => setMark("receiptReprint", v)}
                  />
                  <Checkbox
                    label="販売レシート・ギフトレシート"
                    checked={marks.salesReprint}
                    onChange={(v) => setMark("salesReprint", v)}
                    helpText="この画面の印字で出すレシートだけです。Shopify の標準のレシートには出ません。"
                  />
                  <TextField
                    label="再印字の印の文言"
                    value={marks.reprintText}
                    onChange={(v) => setMark("reprintText", v)}
                    autoComplete="off"
                    maxLength={PRINT_MARK_TEXT_MAX}
                    placeholder={DEFAULT_REPRINT_MARK_TEXT}
                    disabled={!anyReprint}
                    helpText="空のまま保存すると「再印字」になります。"
                  />
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">確定し直した精算</Text>
                  <Checkbox
                    label="「再精算」と出す"
                    checked={marks.resettlement}
                    onChange={(v) => setMark("resettlement", v)}
                    helpText="精算したあとに会計などがあり、POS の「今の数で再確定する」で確定し直した精算のレシートに出ます。前の精算は履歴に残ります。"
                  />
                  <TextField
                    label="再精算の印の文言"
                    value={marks.resettlementText}
                    onChange={(v) => setMark("resettlementText", v)}
                    autoComplete="off"
                    maxLength={PRINT_MARK_TEXT_MAX}
                    placeholder={DEFAULT_RESETTLEMENT_MARK_TEXT}
                    disabled={!marks.resettlement}
                    helpText="空のまま保存すると「再精算」になります。"
                  />
                </BlockStack>
                <Text as="p" tone="subdued">
                  レシートのレイアウトで「再印字・再精算の印」のブロックを置くと、その場所に出します。金額や件数は変わりません。
                </Text>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="領収書" description="領収書を印字するときの決まりです。">
            <Card>
              <Checkbox
                label="印字の前にプレビューを必ず見る"
                checked={form.receiptPreviewBeforePrintRequired}
                onChange={(v) => set("receiptPreviewBeforePrintRequired", v)}
              />
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
