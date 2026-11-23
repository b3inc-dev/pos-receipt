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
import { normalizeOrderRedoMethod } from "../services/orderRedoCartPlan";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<SpecialRefundSettings>>(shop.id, SPECIAL_REFUND_SETTINGS_KEY);
  const merged: SpecialRefundSettings = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...saved };
  const settings: SpecialRefundSettings = {
    ...merged,
    orderRedoMethod: normalizeOrderRedoMethod(merged.orderRedoMethod),
  };
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
    orderRedoMethod: normalizeOrderRedoMethod(get("orderRedoMethod")),
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
            <AdminIntro><p>POS で使う特殊返金の種類と、入力を必ずにする項目・POS に出る名前を決めます。オフにした種類は POS で登録できなくなります。</p></AdminIntro>
          </Layout.Section>

          <Layout.AnnotatedSection
            title="Shopify 返金の実行"
            description="POS で特殊返金を登録したとき、Shopify の注文にも返金を作るかを選びます。商品券調整はいつも記録だけです。"
          >
            <Card>
              <BlockStack gap="400">
                <ChoiceList
                  title="返金のしかた"
                  choices={[
                    {
                      label: "記録だけ",
                      value: "record_only",
                      helpText:
                        "アプリの記録と精算・売上サマリーにだけ入れます。Shopify の注文には返金を作りません。",
                    },
                    {
                      label: "Shopify で返金まで",
                      value: "shopify_execute",
                      helpText:
                        "POS で登録すると、下でオンにした種類は Shopify の注文にも返金を作ります。",
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
                      Shopify で返金まで行う種類（商品券調整は記録だけ）
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
                      label="レシート現金調整（取消だけ。追加徴収は Shopify で返金しません）"
                      checked={form.shopifyExecuteReceiptCashAdjustment}
                      onChange={(v) => set("shopifyExecuteReceiptCashAdjustment", v)}
                    />
                  </>
                ) : null}
                <Checkbox
                  label="登録し直すときは記録だけにする"
                  checked={form.correctionUsesRecordOnly}
                  onChange={(v) => set("correctionUsesRecordOnly", v)}
                  helpText="間違えた登録を無効化して登録し直すとき、Shopify で 2 回返金しないようにします。オンをおすすめします。"
                />
                <Checkbox
                  label="会計やり直し"
                  checked={form.enableOrderRedoDraft}
                  onChange={(v) => set("enableOrderRedoDraft", v)}
                  helpText="キャンセル・返金済みの注文と同じ商品で、もう一度お会計できるようにします。"
                />
                {form.enableOrderRedoDraft ? (
                  <ChoiceList
                    title="会計やり直しの方法"
                    choices={[
                      {
                        label: "カートに入れる・下書き注文の両方（POS で選ぶ）",
                        value: "both",
                        helpText: "POS の注文の詳細に、ボタンを 2 つ出します。",
                      },
                      {
                        label: "カートに入れるだけ",
                        value: "cart",
                        helpText:
                          "同じ商品・お客様・割引を POS のカートに入れ、そのままお会計します。削除した商品は同じ名前・値段のカスタム商品で入ります。",
                      },
                      {
                        label: "下書き注文だけ",
                        value: "draft",
                        helpText: "同じ商品で下書き注文を作ります。お会計は POS か管理画面の「下書き注文」でします。",
                      },
                    ]}
                    selected={[form.orderRedoMethod]}
                    onChange={(v) => set("orderRedoMethod", normalizeOrderRedoMethod(v[0]))}
                  />
                ) : null}
                <Banner tone="warning">
                  「Shopify で返金まで」にすると、POS で登録した金額が Shopify の注文に返金として入ります。登録を無効化しても、Shopify の返金は取り消されません。
                </Banner>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="POS で使う種類">
            <Card>
              <BlockStack gap="300">
                <Checkbox label="現金返金" checked={form.enableCashRefund} onChange={(v) => set("enableCashRefund", v)} />
                <Checkbox label="返金手段変更" checked={form.enablePaymentMethodOverride} onChange={(v) => set("enablePaymentMethodOverride", v)} />
                <Checkbox label="商品券調整" checked={form.enableVoucherChangeAdjustment} onChange={(v) => set("enableVoucherChangeAdjustment", v)} />
                <Checkbox label="レシート現金調整" checked={form.enableReceiptCashAdjustment} onChange={(v) => set("enableReceiptCashAdjustment", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="入力を必ずにする項目">
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

          <Layout.AnnotatedSection title="精算に入れる・POS に出る名前">
            <Card>
              <BlockStack gap="400">
                <Checkbox label="現金返金を精算に反映" checked={form.reflectCashRefundToSettlement} onChange={(v) => set("reflectCashRefundToSettlement", v)} />
                <Checkbox label="返金手段変更を精算に反映" checked={form.reflectPaymentOverrideToSettlement} onChange={(v) => set("reflectPaymentOverrideToSettlement", v)} />
                <Checkbox label="商品券調整を精算に反映" checked={form.reflectVoucherAdjustmentToSettlement} onChange={(v) => set("reflectVoucherAdjustmentToSettlement", v)} />
                <Checkbox label="レシート現金調整を精算に反映" checked={form.reflectReceiptCashAdjustmentToSettlement} onChange={(v) => set("reflectReceiptCashAdjustmentToSettlement", v)} />
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
