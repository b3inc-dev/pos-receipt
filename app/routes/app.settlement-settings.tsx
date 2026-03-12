/**
 * /app/settlement-settings — 精算設定（要件 §5）
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
  SETTLEMENT_SETTINGS_KEY,
  DEFAULT_SETTLEMENT_SETTINGS,
  type SettlementSettings,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

const TAX_DISPLAY_OPTIONS = [
  { label: "税込のみ", value: "inclusive_only" },
  { label: "税込＋監査用", value: "inclusive_and_audit" },
];
const TAX_ROUNDING_OPTIONS = [
  { label: "四捨五入", value: "round" },
  { label: "切り捨て", value: "floor" },
  { label: "切り上げ", value: "ceil" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<SettlementSettings>>(shop.id, SETTLEMENT_SETTINGS_KEY);
  const settings: SettlementSettings = { ...DEFAULT_SETTLEMENT_SETTINGS, ...saved };
  if (typeof settings.taxRatePercent !== "number" || !Number.isFinite(settings.taxRatePercent)) {
    settings.taxRatePercent = 10;
  }
  return { settings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const str = (k: string, d: string) => String(get(k) ?? d).trim();
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const num = (k: string, d: number) => {
    const v = get(k);
    if (v == null || v === "") return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const settings: SettlementSettings = {
    ...DEFAULT_SETTLEMENT_SETTINGS,
    settlementReceiptTitle: str("settlementReceiptTitle", "精算レシート"),
    inspectionReceiptTitle: str("inspectionReceiptTitle", "点検レシート"),
    defaultSettlementNote: str("defaultSettlementNote", ""),
    defaultInspectionNote: str("defaultInspectionNote", ""),
    showTotal: bool("showTotal", true),
    showNetSales: bool("showNetSales", true),
    showTax: bool("showTax", true),
    showDiscounts: bool("showDiscounts", true),
    showLoyaltyUsage: bool("showLoyaltyUsage", true),
    showOrderCount: bool("showOrderCount", true),
    showRefundCount: bool("showRefundCount", true),
    showItemCount: bool("showItemCount", true),
    showPaymentSections: bool("showPaymentSections", true),
    showVoucherChange: bool("showVoucherChange", true),
    showAsOf: bool("showAsOf", true),
    showPeriodLabel: bool("showPeriodLabel", true),
    showLocationLabel: bool("showLocationLabel", true),
    labelTotal: str("labelTotal", "合計"),
    labelNetSales: str("labelNetSales", "売上"),
    labelTax: str("labelTax", "税"),
    labelDiscounts: str("labelDiscounts", "値引"),
    labelLoyaltyUsage: str("labelLoyaltyUsage", "ポイント利用額"),
    labelOrderCount: str("labelOrderCount", "注文数"),
    labelRefundCount: str("labelRefundCount", "返品数"),
    labelItemCount: str("labelItemCount", "商品数"),
    labelVoucherChange: str("labelVoucherChange", "商品券おつり"),
    settlementFieldOrderJson: str("settlementFieldOrderJson", "[]"),
    paymentSectionOrderJson: str("paymentSectionOrderJson", "[]"),
    taxDisplayMode: (get("taxDisplayMode") as SettlementSettings["taxDisplayMode"]) || "inclusive_only",
    taxRoundingMode: (get("taxRoundingMode") as SettlementSettings["taxRoundingMode"]) || "round",
    taxRatePercent: Math.min(100, Math.max(0, num("taxRatePercent", 10))),
    allowRecalculateLatestSettlement: bool("allowRecalculateLatestSettlement", true),
    allowReprintSettlement: bool("allowReprintSettlement", true),
    allowManualTargetDate: bool("allowManualTargetDate", true),
    orderBasedCreateSettlementOrderEnabled: bool("orderBasedCreateSettlementOrderEnabled", true),
    orderBasedAttachMetafieldsEnabled: bool("orderBasedAttachMetafieldsEnabled", true),
    orderBasedAttachNoteEnabled: bool("orderBasedAttachNoteEnabled", true),
  };
  await setAppSetting(shop.id, SETTLEMENT_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function SettlementSettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<SettlementSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      fd.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    });
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = <K extends keyof SettlementSettings>(key: K, value: SettlementSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="精算設定"
        backAction={{ content: "戻る", onAction: () => navigate("/app/settings" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Layout>
          {saved && <Layout.Section><Banner tone="success">保存しました。</Banner></Layout.Section>}
          <Layout.Section>
            <Banner tone="info">精算レシート・点検レシートの表題・表示項目・項目名・税表示・再処理・非対応プリンタ時のルールを設定します。</Banner>
          </Layout.Section>

          <Layout.AnnotatedSection title="精算レシート基本" description="§5.2.1">
            <Card>
              <BlockStack gap="400">
                <TextField label="精算レシートの表題" value={form.settlementReceiptTitle} onChange={(v) => set("settlementReceiptTitle", v)} autoComplete="off" />
                <TextField label="点検レシートの表題" value={form.inspectionReceiptTitle} onChange={(v) => set("inspectionReceiptTitle", v)} autoComplete="off" />
                <TextField label="精算メモデフォルト" value={form.defaultSettlementNote} onChange={(v) => set("defaultSettlementNote", v)} autoComplete="off" />
                <TextField label="点検メモデフォルト" value={form.defaultInspectionNote} onChange={(v) => set("defaultInspectionNote", v)} autoComplete="off" />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="表示項目 ON/OFF" description="§5.2.2">
            <Card>
              <BlockStack gap="200">
                <InlineStack gap="400" wrap>
                  <Checkbox label="合計" checked={form.showTotal} onChange={(v) => set("showTotal", v)} />
                  <Checkbox label="売上" checked={form.showNetSales} onChange={(v) => set("showNetSales", v)} />
                  <Checkbox label="税" checked={form.showTax} onChange={(v) => set("showTax", v)} />
                  <Checkbox label="値引" checked={form.showDiscounts} onChange={(v) => set("showDiscounts", v)} />
                  <Checkbox label="ポイント利用額" checked={form.showLoyaltyUsage} onChange={(v) => set("showLoyaltyUsage", v)} />
                  <Checkbox label="注文数" checked={form.showOrderCount} onChange={(v) => set("showOrderCount", v)} />
                  <Checkbox label="返品数" checked={form.showRefundCount} onChange={(v) => set("showRefundCount", v)} />
                  <Checkbox label="商品数" checked={form.showItemCount} onChange={(v) => set("showItemCount", v)} />
                  <Checkbox label="支払セクション" checked={form.showPaymentSections} onChange={(v) => set("showPaymentSections", v)} />
                  <Checkbox label="商品券おつり" checked={form.showVoucherChange} onChange={(v) => set("showVoucherChange", v)} />
                  <Checkbox label="基準日時" checked={form.showAsOf} onChange={(v) => set("showAsOf", v)} />
                  <Checkbox label="期間ラベル" checked={form.showPeriodLabel} onChange={(v) => set("showPeriodLabel", v)} />
                  <Checkbox label="ロケーションラベル" checked={form.showLocationLabel} onChange={(v) => set("showLocationLabel", v)} />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="項目表示名" description="§5.2.3">
            <Card>
              <BlockStack gap="400">
                <TextField label="合計" value={form.labelTotal} onChange={(v) => set("labelTotal", v)} autoComplete="off" />
                <TextField label="売上" value={form.labelNetSales} onChange={(v) => set("labelNetSales", v)} autoComplete="off" />
                <TextField label="税" value={form.labelTax} onChange={(v) => set("labelTax", v)} autoComplete="off" />
                <TextField label="値引" value={form.labelDiscounts} onChange={(v) => set("labelDiscounts", v)} autoComplete="off" />
                <TextField label="ポイント利用額" value={form.labelLoyaltyUsage} onChange={(v) => set("labelLoyaltyUsage", v)} autoComplete="off" />
                <TextField label="注文数" value={form.labelOrderCount} onChange={(v) => set("labelOrderCount", v)} autoComplete="off" />
                <TextField label="返品数" value={form.labelRefundCount} onChange={(v) => set("labelRefundCount", v)} autoComplete="off" />
                <TextField label="商品数" value={form.labelItemCount} onChange={(v) => set("labelItemCount", v)} autoComplete="off" />
                <TextField label="商品券おつり" value={form.labelVoucherChange} onChange={(v) => set("labelVoucherChange", v)} autoComplete="off" />
                <TextField label="項目順 JSON" value={form.settlementFieldOrderJson} onChange={(v) => set("settlementFieldOrderJson", v)} helpText="§5.2.4" autoComplete="off" />
                <TextField label="支払セクション順 JSON" value={form.paymentSectionOrderJson} onChange={(v) => set("paymentSectionOrderJson", v)} autoComplete="off" />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="税・再処理・非対応プリンタ時" description="§5.2.5, §5.2.6, §5.2.7">
            <Card>
              <BlockStack gap="400">
                <Select label="税表示" options={TAX_DISPLAY_OPTIONS} value={form.taxDisplayMode} onChange={(v) => set("taxDisplayMode", v as SettlementSettings["taxDisplayMode"])} />
                <Select label="税丸め" options={TAX_ROUNDING_OPTIONS} value={form.taxRoundingMode} onChange={(v) => set("taxRoundingMode", v as SettlementSettings["taxRoundingMode"])} />
                <TextField
                  label="消費税率（%）"
                  type="number"
                  value={String(form.taxRatePercent ?? 10)}
                  onChange={(v) => set("taxRatePercent", Math.min(100, Math.max(0, Number(v) || 10)))}
                  autoComplete="off"
                  helpText="精算時の税・純売上算出に使用。例: 10"
                />
                <Checkbox label="最新精算の再計算を許可" checked={form.allowRecalculateLatestSettlement} onChange={(v) => set("allowRecalculateLatestSettlement", v)} />
                <Checkbox label="精算の再印字を許可" checked={form.allowReprintSettlement} onChange={(v) => set("allowReprintSettlement", v)} />
                <Checkbox label="手動で対象日を指定可能" checked={form.allowManualTargetDate} onChange={(v) => set("allowManualTargetDate", v)} />
                <Checkbox label="order_based: 精算注文を作成" checked={form.orderBasedCreateSettlementOrderEnabled} onChange={(v) => set("orderBasedCreateSettlementOrderEnabled", v)} />
                <Checkbox label="order_based: メタフィールドを付与" checked={form.orderBasedAttachMetafieldsEnabled} onChange={(v) => set("orderBasedAttachMetafieldsEnabled", v)} />
                <Checkbox label="order_based: 注文にメモを付与" checked={form.orderBasedAttachNoteEnabled} onChange={(v) => set("orderBasedAttachNoteEnabled", v)} />
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
