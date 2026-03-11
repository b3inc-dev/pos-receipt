/**
 * /app/special-refund-settings — 特殊返金設定
 * 要件 §8: 利用可能イベント種別・入力要件・表示名
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
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  getAppSetting,
  setAppSetting,
  SPECIAL_REFUND_SETTINGS_KEY,
  DEFAULT_SPECIAL_REFUND_SETTINGS,
  type SpecialRefundSettings,
} from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<SpecialRefundSettings>>(shop.id, SPECIAL_REFUND_SETTINGS_KEY);
  const settings: SpecialRefundSettings = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...saved };
  return { settings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const str = (k: string, d: string) => String(get(k) ?? d).trim();
  const settings: SpecialRefundSettings = {
    ...DEFAULT_SPECIAL_REFUND_SETTINGS,
    enableCashRefund: bool("enableCashRefund", true),
    enablePaymentMethodOverride: bool("enablePaymentMethodOverride", true),
    enableVoucherChangeAdjustment: bool("enableVoucherChangeAdjustment", true),
    enableReceiptCashAdjustment: bool("enableReceiptCashAdjustment", true),
    requireOriginalPaymentMethodForPaymentOverride: bool("requireOriginalPaymentMethodForPaymentOverride", true),
    requireActualRefundMethodForPaymentOverride: bool("requireActualRefundMethodForPaymentOverride", true),
    requireNoteForCashRefund: bool("requireNoteForCashRefund", false),
    requireVoucherFaceValueForVoucherChangeAdjustment: bool("requireVoucherFaceValueForVoucherChangeAdjustment", true),
    requireVoucherAppliedAmountForVoucherChangeAdjustment: bool("requireVoucherAppliedAmountForVoucherChangeAdjustment", true),
    requireVoucherChangeAmountForVoucherChangeAdjustment: bool("requireVoucherChangeAmountForVoucherChangeAdjustment", true),
    reflectCashRefundToSettlement: bool("reflectCashRefundToSettlement", true),
    reflectPaymentOverrideToSettlement: bool("reflectPaymentOverrideToSettlement", true),
    reflectVoucherAdjustmentToSettlement: bool("reflectVoucherAdjustmentToSettlement", true),
    reflectReceiptCashAdjustmentToSettlement: bool("reflectReceiptCashAdjustmentToSettlement", true),
    specialRefundUiLabel: str("specialRefundUiLabel", "特殊返金"),
    voucherAdjustmentUiLabel: str("voucherAdjustmentUiLabel", "商品券調整"),
    cashRefundUiLabel: str("cashRefundUiLabel", "現金返金"),
    paymentOverrideUiLabel: str("paymentOverrideUiLabel", "返金手段変更"),
  };
  await setAppSetting(shop.id, SPECIAL_REFUND_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function SpecialRefundSettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<SpecialRefundSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      fd.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    });
    submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const set = <K extends keyof SpecialRefundSettings>(key: K, value: SpecialRefundSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="特殊返金設定"
        backAction={{ content: "戻る", onAction: () => navigate("/app/settings" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Layout>
          {saved && <Layout.Section><Banner tone="success">保存しました。</Banner></Layout.Section>}
          <Layout.Section>
            <Banner tone="info">
              POS で利用できる特殊返金の種別と、各種別の入力要件・表示名を設定します。OFF にした種別は API でも拒否されます。
            </Banner>
          </Layout.Section>

          <Layout.AnnotatedSection title="利用可能イベント種別" description="§8.2.1">
            <Card>
              <BlockStack gap="300">
                <Checkbox label="現金返金" checked={form.enableCashRefund} onChange={(v) => set("enableCashRefund", v)} />
                <Checkbox label="返金手段変更" checked={form.enablePaymentMethodOverride} onChange={(v) => set("enablePaymentMethodOverride", v)} />
                <Checkbox label="商品券調整" checked={form.enableVoucherChangeAdjustment} onChange={(v) => set("enableVoucherChangeAdjustment", v)} />
                <Checkbox label="レシート現金調整" checked={form.enableReceiptCashAdjustment} onChange={(v) => set("enableReceiptCashAdjustment", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="入力要件" description="§8.2.2">
            <Card>
              <BlockStack gap="300">
                <Checkbox label="返金手段変更: 元の支払手段を必須" checked={form.requireOriginalPaymentMethodForPaymentOverride} onChange={(v) => set("requireOriginalPaymentMethodForPaymentOverride", v)} />
                <Checkbox label="返金手段変更: 実際の返金手段を必須" checked={form.requireActualRefundMethodForPaymentOverride} onChange={(v) => set("requireActualRefundMethodForPaymentOverride", v)} />
                <Checkbox label="現金返金: メモを必須" checked={form.requireNoteForCashRefund} onChange={(v) => set("requireNoteForCashRefund", v)} />
                <Checkbox label="商品券調整: 額面を必須" checked={form.requireVoucherFaceValueForVoucherChangeAdjustment} onChange={(v) => set("requireVoucherFaceValueForVoucherChangeAdjustment", v)} />
                <Checkbox label="商品券調整: 使用額を必須" checked={form.requireVoucherAppliedAmountForVoucherChangeAdjustment} onChange={(v) => set("requireVoucherAppliedAmountForVoucherChangeAdjustment", v)} />
                <Checkbox label="商品券調整: おつり額を必須" checked={form.requireVoucherChangeAmountForVoucherChangeAdjustment} onChange={(v) => set("requireVoucherChangeAmountForVoucherChangeAdjustment", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="精算反映・表示名" description="§8.2.3, §8.2.4">
            <Card>
              <BlockStack gap="400">
                <Checkbox label="現金返金を精算に反映" checked={form.reflectCashRefundToSettlement} onChange={(v) => set("reflectCashRefundToSettlement", v)} />
                <Checkbox label="返金手段変更を精算に反映" checked={form.reflectPaymentOverrideToSettlement} onChange={(v) => set("reflectPaymentOverrideToSettlement", v)} />
                <Checkbox label="商品券調整を精算に反映" checked={form.reflectVoucherAdjustmentToSettlement} onChange={(v) => set("reflectVoucherAdjustmentToSettlement", v)} />
                <Checkbox label="レシート現金調整を精算に反映" checked={form.reflectReceiptCashAdjustmentToSettlement} onChange={(v) => set("reflectReceiptCashAdjustmentToSettlement", v)} />
                <TextField label="特殊返金のUIラベル" value={form.specialRefundUiLabel} onChange={(v) => set("specialRefundUiLabel", v)} autoComplete="off" />
                <TextField label="商品券調整のUIラベル" value={form.voucherAdjustmentUiLabel} onChange={(v) => set("voucherAdjustmentUiLabel", v)} autoComplete="off" />
                <TextField label="現金返金のUIラベル" value={form.cashRefundUiLabel} onChange={(v) => set("cashRefundUiLabel", v)} autoComplete="off" />
                <TextField label="返金手段変更のUIラベル" value={form.paymentOverrideUiLabel} onChange={(v) => set("paymentOverrideUiLabel", v)} autoComplete="off" />
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
