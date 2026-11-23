/**
 * /app/special-refund-settings — 特殊返金設定
 * 要件 §8: 利用可能イベント種別・入力要件・表示名
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useFetcher, useLoaderData, useSubmit, useLocation, useNavigate } from "react-router";
import { SuccessToast, AdminIntro } from "../components/admin-ui";
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
import {
  backfillOrderAdjustmentsMetafield,
  countOrdersNotWrittenYet,
  ORDER_ADJUSTMENTS_BACKFILL_MAX,
} from "../services/orderAdjustments.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<SpecialRefundSettings>>(shop.id, SPECIAL_REFUND_SETTINGS_KEY);
  const settings: SpecialRefundSettings = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...saved };
  // 前からの登録で、まだ注文に書いていない注文の数（注文に書く設定がオンのときだけ数える）
  const notWrittenCount = settings.writeOrderAdjustmentsMetafield ? await countOrdersNotWrittenYet(shop.id) : 0;
  return { settings, notWrittenCount, backfillMax: ORDER_ADJUSTMENTS_BACKFILL_MAX };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  if (get("intent") === "backfill") {
    // 前からの登録を注文に書く（T が 1 件だけ→まとめて の順で押す。精算ではまとめて書かない）
    const limit = Number(get("limit") ?? 1);
    const r = await backfillOrderAdjustmentsMetafield(admin, shop.id, Number.isFinite(limit) ? limit : 1);
    return Response.json({ intent: "backfill", ...r, at: Date.now() });
  }
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const str = (k: string, d: string) => String(get(k) ?? d).trim();
  // 初めの値は記録だけ（T の決定 2026-11-23: 返金は純正で行う。保存した店はその値のまま）
  const modeRaw = str("refundProcessingMode", "record_only");
  const refundProcessingMode =
    modeRaw === "shopify_execute" ? "shopify_execute" : "record_only";
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
    enableReceiptCashAdjustment: bool("enableReceiptCashAdjustment", false),
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
    writeOrderAdjustmentsMetafield: bool("writeOrderAdjustmentsMetafield", false),
    specialRefundUiLabel: str("specialRefundUiLabel", "特殊返金"),
    voucherAdjustmentUiLabel: str("voucherAdjustmentUiLabel", "商品券釣銭登録"),
    cashRefundUiLabel: str("cashRefundUiLabel", "現金返金"),
    paymentOverrideUiLabel: str("paymentOverrideUiLabel", "返金方法変更"),
  };
  await setAppSetting(shop.id, SPECIAL_REFUND_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function SpecialRefundSettingsPage() {
  const { settings: initial, notWrittenCount, backfillMax } = useLoaderData<typeof loader>();
  const backfill = useFetcher<
    | { intent: "backfill"; ok: true; written: { orderName: string }[]; failed: { orderName: string; error: string }[]; remaining: number }
    | { intent: "backfill"; ok: false; reason: "off" }
  >();
  const backfillBusy = backfill.state !== "idle";
  const runBackfill = (limit: number) => {
    const fd = new FormData();
    fd.set("intent", "backfill");
    fd.set("limit", String(limit));
    backfill.submit(fd, { method: "post" });
  };
  const backfillResult = backfill.data;
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
            <AdminIntro><p>POS の「返金」タイルで使う登録の種類と、Shopify の注文に返金を作るか・精算に入れるかを決めます。オフにした種類は POS で登録できなくなります。</p></AdminIntro>
          </Layout.Section>

          <Layout.AnnotatedSection
            title="Shopify 返金の実行"
            description="返金は POS の純正の返金で行い、タイルでは返金方法を変更します。純正で返金した注文の返金方法変更は、ここの選び方に関係なく Shopify では返金しません（金額は純正の返金のまま）。ここで選ぶのは、純正の返金が無い注文で返金方法変更を登録したときだけです。商品券釣銭登録とレシートの現金を直すは、いつも記録だけです。"
          >
            <Card>
              <BlockStack gap="400">
                <ChoiceList
                  title="返金のしかた（純正の返金が無い注文）"
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
                        "POS で登録すると、Shopify の注文にも元の支払いへの返金を作ります。",
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
                    {/* 現金で返した（cash_refund）・ほかの返金方法で返した（payment_method_override）は POS では 1 つの「返金方法変更」。設定の値は 2 つのまま、まとめて切り替える */}
                    <Checkbox
                      label="返金方法変更で、Shopify で返金まで行う"
                      checked={form.shopifyExecuteCashRefund || form.shopifyExecutePaymentMethodOverride}
                      onChange={(v) => {
                        set("shopifyExecuteCashRefund", v);
                        set("shopifyExecutePaymentMethodOverride", v);
                      }}
                      helpText={
                        form.shopifyExecuteCashRefund !== form.shopifyExecutePaymentMethodOverride
                          ? "今は「現金で返した」と「ほかの返金方法で返した」で設定が分かれています。押すと 2 つそろえます。"
                          : undefined
                      }
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
                  label="会計やり直し（下書き注文を作成）"
                  checked={form.enableOrderRedoDraft}
                  onChange={(v) => set("enableOrderRedoDraft", v)}
                  helpText="キャンセル・返金済みの取引から、同じ商品構成の下書き注文を POS で作成できます。決済は POS または管理画面で行います。"
                />
                <Banner tone="warning">
                  「Shopify で返金まで」にすると、純正の返金が無い注文で POS で登録した金額が、Shopify の注文に返金として入ります。登録を無効化しても、Shopify の返金は取り消されません。
                </Banner>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="POS で使う種類"
            description="POS の登録の画面に出る種類です。返金方法が現金かどうかで、記録の種類（現金返金・返金方法変更）は自動で決まります。"
          >
            <Card>
              <BlockStack gap="300">
                <Checkbox
                  label="返金方法変更"
                  checked={form.enableCashRefund || form.enablePaymentMethodOverride}
                  onChange={(v) => {
                    set("enableCashRefund", v);
                    set("enablePaymentMethodOverride", v);
                  }}
                  helpText={
                    form.enableCashRefund !== form.enablePaymentMethodOverride
                      ? `今は${form.enableCashRefund ? "現金で返したときだけ" : "現金以外で返したときだけ"}使えます。押すと 2 つそろえます。`
                      : "お客様が払った支払方法とは別の返金方法で返したときに使います。例: 施設ポイントで払った分を現金で返した。返金の合計は変わらず、精算の返金方法の内訳だけが移ります。 純正で返金した注文は、返金を選んで金額はそのまま、返金方法だけ選びます。"
                  }
                />
                <Checkbox
                  label="レシートの現金を直す"
                  checked={form.enableReceiptCashAdjustment}
                  onChange={(v) => set("enableReceiptCashAdjustment", v)}
                  helpText="返金ではありません。レシート（Shopify の記録）と実際のレジの現金が合わないときに使います。例: 返金を打ったが、お客様に現金を渡さなかった。Shopify では返金も注文の変更もしません。精算の数字だけが変わります。 「返金を取り消す」「現金を足す」の 2 つから選びます。"
                />
                <Checkbox
                  label="商品券釣銭登録"
                  checked={form.enableVoucherChangeAdjustment}
                  onChange={(v) => set("enableVoucherChangeAdjustment", v)}
                  helpText="商品券で払ってお釣りを現金で渡したときの記録です。数え方は「商品券設定」で決めます。"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="管理者の承認"
            description="返金方法変更を、管理者が承認してから精算に入れるかを選びます。"
          >
            <Card>
              <BlockStack gap="300">
                <Checkbox
                  label="返金方法変更は管理者の承認のあとで精算に入れる"
                  checked={form.requireApprovalForPaymentMethodOverride}
                  onChange={(v) => set("requireApprovalForPaymentMethodOverride", v)}
                  helpText="オンにすると、POS で登録した返金方法変更と現金返金（純正の返金の返金方法変更・返金の予約を含む）は「承認待ち」になり、「返金方法変更・商品券釣銭登録 履歴」で承認するまで精算・点検・売上サマリーに入りません。却下したものは入りません。Shopify での返金の実行は今までどおりで、承認・却下では Shopify に何もしません。オフのときは今までどおり、登録した時点で精算に入ります。"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="注文への記録"
            description="返金方法変更・商品券釣銭登録を Shopify の注文にも記録するかを選びます。"
          >
            <Card>
              <BlockStack gap="300">
                <Checkbox
                  label="返金方法変更・商品券釣銭登録を注文にも記録する"
                  checked={form.writeOrderAdjustmentsMetafield}
                  onChange={(v) => set("writeOrderAdjustmentsMetafield", v)}
                  helpText="オンにすると、登録・変更・無効化のたびに、その注文に記録を書きます。注文を読むほかのアプリ（ciara-system など）が同じ記録で数えられます。精算はアプリの記録で数え、注文の記録が違うときはアプリの記録で書き直します。オンにする前の登録は、下の「前からの登録を注文に書く」で書きます。オフのときは注文に何も書かず、今までどおりアプリの記録だけで数えます。"
                />
                {initial.writeOrderAdjustmentsMetafield ? (
                  <>
                    <Divider />
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">前からの登録を注文に書く</Text>
                      <Text as="p" tone="subdued">
                        {`オンにする前の登録で、まだ注文に書いていない注文が ${backfillResult?.ok ? backfillResult.remaining : notWrittenCount} 件あります。精算ではまとめて書かないので、ここから書きます。注文を書くと売上サマリーの計算し直しが走るので、まず 1 件だけ書いて注文ページで確かめてから、${backfillMax} 件ずつ書いてください。`}
                      </Text>
                      <InlineStack gap="200">
                        <Button
                          onClick={() => runBackfill(1)}
                          loading={backfillBusy}
                          disabled={(backfillResult?.ok ? backfillResult.remaining : notWrittenCount) === 0}
                        >
                          1 件だけ書く
                        </Button>
                        <Button
                          onClick={() => runBackfill(backfillMax)}
                          loading={backfillBusy}
                          disabled={(backfillResult?.ok ? backfillResult.remaining : notWrittenCount) === 0}
                        >
                          {`${backfillMax} 件書く`}
                        </Button>
                      </InlineStack>
                      {backfillResult && !backfillResult.ok ? (
                        <Text as="p" tone="critical">注文への記録がオフになっています。オンにして保存してから押してください。</Text>
                      ) : null}
                      {backfillResult?.ok ? (
                        <BlockStack gap="100">
                          <Text as="p">
                            {`書きました: ${backfillResult.written.length} 件${backfillResult.written.length > 0 ? `（${backfillResult.written.map((w) => w.orderName).join("、")}）` : ""}`}
                          </Text>
                          {backfillResult.failed.map((f) => (
                            <Text as="p" tone="critical" key={f.orderName}>{`書けませんでした: ${f.orderName}（${f.error}）。次からは精算のときに書き直します。`}</Text>
                          ))}
                        </BlockStack>
                      ) : null}
                    </BlockStack>
                  </>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="精算に入れる"
            description="オフにした種類は、登録しても精算・点検・売上サマリーに入れません。"
          >
            <Card>
              <BlockStack gap="400">
                <Checkbox
                  label="「返金方法変更」を精算に入れる"
                  checked={form.reflectCashRefundToSettlement || form.reflectPaymentOverrideToSettlement}
                  onChange={(v) => {
                    set("reflectCashRefundToSettlement", v);
                    set("reflectPaymentOverrideToSettlement", v);
                  }}
                  helpText={
                    form.reflectCashRefundToSettlement !== form.reflectPaymentOverrideToSettlement
                      ? "今は「現金で返した」と「ほかの返金方法で返した」で設定が分かれています。押すと 2 つそろえます。"
                      : undefined
                  }
                />
                <Checkbox label="「商品券釣銭登録」を精算に入れる" checked={form.reflectVoucherAdjustmentToSettlement} onChange={(v) => set("reflectVoucherAdjustmentToSettlement", v)} />
                <Checkbox label="「レシートの現金を直す」を精算に入れる" checked={form.reflectReceiptCashAdjustmentToSettlement} onChange={(v) => set("reflectReceiptCashAdjustmentToSettlement", v)} />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
