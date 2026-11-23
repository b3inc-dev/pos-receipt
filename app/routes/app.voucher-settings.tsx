/**
 * /app/voucher-settings — 商品券設定
 * 要件 §7: 商品券機能・額面読取・精算反映
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
  Select,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  getAppSetting,
  setAppSetting,
  VOUCHER_SETTINGS_KEY,
  DEFAULT_VOUCHER_SETTINGS,
  type VoucherSettings,
} from "../utils/appSettings.server";
import {
  compileVoucherNoteRegex,
  resolveVoucherSettings,
  VOUCHER_SETTINGS_VERSION,
} from "../services/voucherChangePure.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";

const PRIORITY_OPTIONS = [
  { label: "手動優先", value: "manual_first" },
  { label: "自動優先", value: "auto_first" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<VoucherSettings>>(shop.id, VOUCHER_SETTINGS_KEY);
  // 配線前に保存した設定（版なし）は「注文メモから額面を読む」を ON とみなす（精算と同じ解釈で見せる）
  const { settingsVersion: _v, ...settings } = resolveVoucherSettings(saved, DEFAULT_VOUCHER_SETTINGS);
  return { settings: settings as VoucherSettings };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const bool = (k: string, def: boolean) => get(k) === "true" || (def && get(k) !== "false");
  const settings: VoucherSettings = {
    ...DEFAULT_VOUCHER_SETTINGS,
    voucherFeatureEnabled: bool("voucherFeatureEnabled", true),
    voucherAutoDetectionEnabled: bool("voucherAutoDetectionEnabled", true),
    voucherManualAdjustmentEnabled: bool("voucherManualAdjustmentEnabled", true),
    voucherNoteParseEnabled: bool("voucherNoteParseEnabled", true),
    voucherNoteParseRegex: String(get("voucherNoteParseRegex") ?? "").trim(),
    voucherDefaultLabel: String(get("voucherDefaultLabel") ?? "商品券").trim(),
    voucherAdjustmentPriority: (get("voucherAdjustmentPriority") as "manual_first" | "auto_first") || "manual_first",
    reflectVoucherChangeInSettlement: bool("reflectVoucherChangeInSettlement", true),
    reflectVoucherChangeInReceiptDisplay: bool("reflectVoucherChangeInReceiptDisplay", true),
    voucherChangeDisplayLabel: String(get("voucherChangeDisplayLabel") ?? "商品券おつり").trim(),
  };
  const regexCheck = compileVoucherNoteRegex(settings.voucherNoteParseRegex);
  if (regexCheck.error) {
    return Response.json({ ok: false, error: regexCheck.error }, { status: 400 });
  }
  if (!settings.voucherDefaultLabel) settings.voucherDefaultLabel = DEFAULT_VOUCHER_SETTINGS.voucherDefaultLabel;
  await setAppSetting(shop.id, VOUCHER_SETTINGS_KEY, { ...settings, settingsVersion: VOUCHER_SETTINGS_VERSION });
  return Response.json({ ok: true });
}

export default function VoucherSettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const actionData = useActionData<{ ok?: boolean; error?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const q = location.search || "";
  const [form, setForm] = useState<VoucherSettings>({ ...initial });

  const handleSave = () => {
    const fd = new FormData();
    fd.set("voucherFeatureEnabled", form.voucherFeatureEnabled ? "true" : "false");
    fd.set("voucherAutoDetectionEnabled", form.voucherAutoDetectionEnabled ? "true" : "false");
    fd.set("voucherManualAdjustmentEnabled", form.voucherManualAdjustmentEnabled ? "true" : "false");
    fd.set("voucherNoteParseEnabled", form.voucherNoteParseEnabled ? "true" : "false");
    fd.set("voucherNoteParseRegex", form.voucherNoteParseRegex);
    fd.set("voucherDefaultLabel", form.voucherDefaultLabel);
    fd.set("voucherAdjustmentPriority", form.voucherAdjustmentPriority);
    fd.set("reflectVoucherChangeInSettlement", form.reflectVoucherChangeInSettlement ? "true" : "false");
    fd.set("reflectVoucherChangeInReceiptDisplay", form.reflectVoucherChangeInReceiptDisplay ? "true" : "false");
    fd.set("voucherChangeDisplayLabel", form.voucherChangeDisplayLabel);
    submit(fd, { method: "post" });
  };

  const set = <K extends keyof VoucherSettings>(key: K, value: VoucherSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <PolarisPageWrapper>
      <Page
        title="商品券設定"
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
            <AdminIntro><p>商品券のお釣り（精算の「商品券釣有り差額」）の数え方を決めます。同じ注文に自動判定と POS の商品券調整の両方があるときは、判定優先順位の方だけを数えます。</p></AdminIntro>
          </Layout.Section>
          {actionData?.error ? (
            <Layout.Section>
              <Banner tone="critical" title="保存できませんでした">
                <p>{actionData.error}</p>
              </Banner>
            </Layout.Section>
          ) : null}

          <Layout.AnnotatedSection title="商品券機能全体">
            <Card>
              <BlockStack gap="300">
                <Checkbox label="商品券機能を有効にする" checked={form.voucherFeatureEnabled} onChange={(v) => set("voucherFeatureEnabled", v)} />
                <Checkbox
                  label="自動判定を有効にする"
                  helpText="現金の預かりが会計に必要な額より多い注文や、注文メモの額面から、お釣りを見つけます。"
                  checked={form.voucherAutoDetectionEnabled}
                  onChange={(v) => set("voucherAutoDetectionEnabled", v)}
                />
                <Checkbox
                  label="手動調整を有効にする"
                  helpText="オフにすると、POS の「商品券釣銭調整」で登録できなくなり、登録済みの分も精算に数えません。"
                  checked={form.voucherManualAdjustmentEnabled}
                  onChange={(v) => set("voucherManualAdjustmentEnabled", v)}
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="額面読取ルール">
            <Card>
              <BlockStack gap="400">
                <Checkbox label="注文メモから額面を読み取る" checked={form.voucherNoteParseEnabled} onChange={(v) => set("voucherNoteParseEnabled", v)} />
                <TextField
                  label="読取用正規表現"
                  helpText="空のときは「（商品券の言葉） 2000円」の形を読みます。自分で書くときは、金額の部分を ( ) で囲みます。"
                  value={form.voucherNoteParseRegex}
                  onChange={(v) => set("voucherNoteParseRegex", v)}
                  autoComplete="off"
                />
                <TextField
                  label="商品券とみなす言葉"
                  helpText="注文メモや支払方法の名前にこの言葉があると商品券の注文とみなします。支払方法「（言葉）釣有り」「（言葉）釣無し」「（言葉）」は額面どおりに数えます。"
                  value={form.voucherDefaultLabel}
                  onChange={(v) => set("voucherDefaultLabel", v)}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="判定優先順位・精算反映">
            <Card>
              <BlockStack gap="400">
                <Select label="判定優先順位" helpText="同じ注文に自動判定と手動調整の両方があるとき、どちらを数えるか。もう片方は数えません（同じ日・同じ店の精算の中で）。" options={PRIORITY_OPTIONS} value={form.voucherAdjustmentPriority} onChange={(v) => set("voucherAdjustmentPriority", v as "manual_first" | "auto_first")} />
                <Checkbox label="精算に商品券おつりを反映する" checked={form.reflectVoucherChangeInSettlement} onChange={(v) => set("reflectVoucherChangeInSettlement", v)} />
                <Text as="p" variant="bodySm" tone="subdued">
                  精算レシートに差額の行を出すかは「精算レシート印字レイアウト」の「商品券釣有り差額行を含める」で決めます。
                </Text>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
