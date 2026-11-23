/**
 * /app/special-refund-settings — 特殊返金設定
 * 要件 §8: 利用可能イベント種別・入力要件・表示名
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useSubmit, useLocation, useNavigate } from "react-router";
import { SuccessToast, AdminIntro } from "../components/admin-ui";
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
  ChoiceList,
  Divider,
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
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";

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
  const modeRaw = str("refundProcessingMode", "shopify_execute");
  const refundProcessingMode =
    modeRaw === "record_only" ? "record_only" : "shopify_execute";
  const settings: SpecialRefundSettings = {
    ...DEFAULT_SPECIAL_REFUND_SETTINGS,
    refundProcessingMode,
    shopifyExecuteCashRefund: bool("shopifyExecuteCashRefund", true),
    shopifyExecutePaymentMethodOverride: bool("shopifyExecutePaymentMethodOverride", true),
    shopifyExecuteReceiptCashAdjustment: bool("shopifyExecuteReceiptCashAdjustment", true),
    correctionUsesRecordOnly: bool("correctionUsesRecordOnly", true),
    enableOrderRedoDraft: bool("enableOrderRedoDraft", true),
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
    requireApprovalForPaymentMethodOverride: bool("requireApprovalForPaymentMethodOverride", false),
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
  const actionData = useActionData<{ ok?: boolean }>();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [form, setForm] = useState<SpecialRefundSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      fd.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    });
    submit(fd, { method: "post" });
  };

  const set = <K extends keyof SpecialRefundSettings>(key: K, value: SpecialRefundSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="特殊返金設定"
        backAction={{ content: "ホーム", onAction: () => navigate("/app" + q) }}
        primaryAction={{ content: "保存", onAction: handleSave }}
      >
        <Card padding="0">
          <TabGroupBar tabs={SETTLEMENT_TABS} />
        </Card>
        <Layout>
          {/* 保存の成功はトーストで出し、保存のたびに出す（UI ルール v1.1 7章） */}
          <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
          <Layout.Section>
            {/* 画面全体の説明は AdminIntro（1〜2文）。お知らせ枠は1画面に1つまでにする（2章・5章） */}
            <AdminIntro><p>POS の特殊返金で使える種類と、入力の決まり・精算への入れ方・POS に出る名前を決めます。オフにした種類は POS から登録できません。</p></AdminIntro>
          </Layout.Section>

          <Layout.AnnotatedSection
            title="Shopify での返金"
            description="POS で登録したとき、Shopify の注文でも返金するかを選びます。商品券調整はいつも記録だけです。"
          >
            <Card>
              <BlockStack gap="400">
                <ChoiceList
                  title="登録したときの動き"
                  choices={[
                    {
                      label: "記録だけ",
                      value: "record_only",
                      helpText:
                        "このアプリの精算・売上サマリーにだけ入れます。Shopify の注文には返金を作りません。",
                    },
                    {
                      label: "Shopify で返金まで",
                      value: "shopify_execute",
                      helpText:
                        "POS で登録すると、下でオンにした種類について Shopify の注文でも返金します。",
                    },
                  ]}
                  selected={[form.refundProcessingMode]}
                  onChange={(v) =>
                    set(
                      "refundProcessingMode",
                      (v[0] === "record_only" ? "record_only" : "shopify_execute"),
                    )
                  }
                />
                {form.refundProcessingMode === "shopify_execute" ? (
                  <>
                    <Divider />
                    <Text as="p" variant="bodySm" tone="subdued">
                      Shopify で返金する種類（商品券調整は対象外）
                    </Text>
                    <Checkbox
                      label="現金返金"
                      checked={form.shopifyExecuteCashRefund}
                      onChange={(v) => set("shopifyExecuteCashRefund", v)}
                    />
                    <Checkbox
                      label="返金手段変更"
                      checked={form.shopifyExecutePaymentMethodOverride}
                      onChange={(v) => set("shopifyExecutePaymentMethodOverride", v)}
                    />
                    <Checkbox
                      label="レシート現金調整（取消だけ。追加でもらうときは Shopify で返金しません）"
                      checked={form.shopifyExecuteReceiptCashAdjustment}
                      onChange={(v) => set("shopifyExecuteReceiptCashAdjustment", v)}
                    />
                  </>
                ) : null}
                <Checkbox
                  label="直すときは記録だけ（同じ取引で無効にしたあとの登録し直しでは Shopify で返金しない）"
                  checked={form.correctionUsesRecordOnly}
                  onChange={(v) => set("correctionUsesRecordOnly", v)}
                  helpText="間違えた登録を無効にして登録し直すとき、二重の返金を防ぎます。オンをおすすめします。"
                />
                <Checkbox
                  label="会計やり直し（下書き注文を作成）"
                  checked={form.enableOrderRedoDraft}
                  onChange={(v) => set("enableOrderRedoDraft", v)}
                  helpText="キャンセル・返金済みの取引から、同じ商品構成の下書き注文を POS で作成できます。決済は POS または管理画面で行います。"
                />
                <Banner tone="warning">
                  「Shopify で返金まで」にすると、POS で登録した金額が Shopify の注文に返金として残ります。登録を無効にしても、Shopify の返金は取り消されません。
                </Banner>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="使える種類" description="POS の特殊返金で選べる種類です。">
            <Card>
              <BlockStack gap="300">
                <Checkbox label="現金返金" checked={form.enableCashRefund} onChange={(v) => set("enableCashRefund", v)} />
                <Checkbox label="返金手段変更" checked={form.enablePaymentMethodOverride} onChange={(v) => set("enablePaymentMethodOverride", v)} />
                <Checkbox label="商品券調整" checked={form.enableVoucherChangeAdjustment} onChange={(v) => set("enableVoucherChangeAdjustment", v)} />
                <Checkbox label="レシート現金調整" checked={form.enableReceiptCashAdjustment} onChange={(v) => set("enableReceiptCashAdjustment", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="管理者の承認"
            description="付け替え（返金手段変更・現金返金）を、管理者が承認してから精算に入れるかを選びます。"
          >
            <Card>
              <BlockStack gap="300">
                <Checkbox
                  label="付け替えは管理者の承認のあとで精算に入れる"
                  checked={form.requireApprovalForPaymentMethodOverride}
                  onChange={(v) => set("requireApprovalForPaymentMethodOverride", v)}
                  helpText="オンにすると、返金手段変更と現金返金は「承認待ち」になり、「特殊返金・商品券調整 履歴」で承認するまで精算・売上サマリーに入りません。承認・却下では Shopify に何もしません。"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="入力の決まり">
            <Card>
              <BlockStack gap="300">
                <Checkbox label="返金手段変更: 元の支払方法を必ず入れる" checked={form.requireOriginalPaymentMethodForPaymentOverride} onChange={(v) => set("requireOriginalPaymentMethodForPaymentOverride", v)} />
                <Checkbox label="返金手段変更: 実際に返した手段を必ず入れる" checked={form.requireActualRefundMethodForPaymentOverride} onChange={(v) => set("requireActualRefundMethodForPaymentOverride", v)} />
                <Checkbox label="現金返金: メモを必ず入れる" checked={form.requireNoteForCashRefund} onChange={(v) => set("requireNoteForCashRefund", v)} />
                <Checkbox label="商品券調整: 額面を必ず入れる" checked={form.requireVoucherFaceValueForVoucherChangeAdjustment} onChange={(v) => set("requireVoucherFaceValueForVoucherChangeAdjustment", v)} />
                <Checkbox label="商品券調整: 使った額を必ず入れる" checked={form.requireVoucherAppliedAmountForVoucherChangeAdjustment} onChange={(v) => set("requireVoucherAppliedAmountForVoucherChangeAdjustment", v)} />
                <Checkbox label="商品券調整: おつりの額を必ず入れる" checked={form.requireVoucherChangeAmountForVoucherChangeAdjustment} onChange={(v) => set("requireVoucherChangeAmountForVoucherChangeAdjustment", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="精算への入れ方と POS に出る名前">
            <Card>
              <BlockStack gap="400">
                <Checkbox label="現金返金を精算に入れる" checked={form.reflectCashRefundToSettlement} onChange={(v) => set("reflectCashRefundToSettlement", v)} />
                <Checkbox label="返金手段変更を精算に入れる" checked={form.reflectPaymentOverrideToSettlement} onChange={(v) => set("reflectPaymentOverrideToSettlement", v)} />
                <Checkbox label="商品券調整を精算に入れる" checked={form.reflectVoucherAdjustmentToSettlement} onChange={(v) => set("reflectVoucherAdjustmentToSettlement", v)} />
                <Checkbox label="レシート現金調整を精算に入れる" checked={form.reflectReceiptCashAdjustmentToSettlement} onChange={(v) => set("reflectReceiptCashAdjustmentToSettlement", v)} />
                <TextField label="POS に出る名前（特殊返金）" value={form.specialRefundUiLabel} onChange={(v) => set("specialRefundUiLabel", v)} autoComplete="off" />
                <TextField label="POS に出る名前（商品券調整）" value={form.voucherAdjustmentUiLabel} onChange={(v) => set("voucherAdjustmentUiLabel", v)} autoComplete="off" />
                <TextField label="POS に出る名前（現金返金）" value={form.cashRefundUiLabel} onChange={(v) => set("cashRefundUiLabel", v)} autoComplete="off" />
                <TextField label="POS に出る名前（返金手段変更）" value={form.paymentOverrideUiLabel} onChange={(v) => set("paymentOverrideUiLabel", v)} autoComplete="off" />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
