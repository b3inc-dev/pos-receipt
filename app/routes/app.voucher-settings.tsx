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
  ChoiceList,
} from "@shopify/polaris";
import { useMemo, useState } from "react";
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
import { compileVoucherNoteRegex as compileNoteRegexForPreview, parseVoucherFaceFromNote } from "../utils/voucherNoteParse";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { TabGroupBar, SETTLEMENT_TABS } from "../components/TabGroupBar";

const PRIORITY_CHOICES = [
  {
    label: "POS で手で入れた額を使う（おすすめ）",
    value: "manual_first",
    helpText: "スタッフが「商品券釣銭登録」で入れた額を正しいものとして、自動で見つけた額は数えません。",
  },
  {
    label: "自動で見つけた額を使う",
    value: "auto_first",
    helpText: "注文から自動で見つけた額を使い、手で入れた額は数えません。",
  },
];

/** 額面の読み方（式が空＝初めの読み方） */
const NOTE_FORMAT_STANDARD = "standard";
const NOTE_FORMAT_CUSTOM = "custom";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const saved = await getAppSetting<Partial<VoucherSettings>>(shop.id, VOUCHER_SETTINGS_KEY);
  // 版の無い設定は、精算と同じく全部初めの値として見せる（保存すると版が付き、保存した値が効き始める）
  const { settingsVersion: _v, legacy, ...settings } = resolveVoucherSettings(saved, DEFAULT_VOUCHER_SETTINGS);
  return { settings: settings as VoucherSettings, legacy };
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
    deductVoucherChangeFromCashDeposit: bool("deductVoucherChangeFromCashDeposit", true),
    reflectVoucherChangeInReceiptDisplay: bool("reflectVoucherChangeInReceiptDisplay", true),
    voucherChangeDisplayLabel: String(get("voucherChangeDisplayLabel") ?? "商品券おつり").trim(),
    voucherCartEntryEnabled: bool("voucherCartEntryEnabled", false),
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
  const { settings: initial, legacy } = useLoaderData<typeof loader>();
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
    fd.set("deductVoucherChangeFromCashDeposit", form.deductVoucherChangeFromCashDeposit ? "true" : "false");
    fd.set("reflectVoucherChangeInReceiptDisplay", form.reflectVoucherChangeInReceiptDisplay ? "true" : "false");
    fd.set("voucherChangeDisplayLabel", form.voucherChangeDisplayLabel);
    fd.set("voucherCartEntryEnabled", form.voucherCartEntryEnabled ? "true" : "false");
    submit(fd, { method: "post" });
  };

  const set = <K extends keyof VoucherSettings>(key: K, value: VoucherSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const keyword = form.voucherDefaultLabel.trim() || "商品券";
  const [noteFormat, setNoteFormat] = useState(
    initial.voucherNoteParseRegex.trim() ? NOTE_FORMAT_CUSTOM : NOTE_FORMAT_STANDARD,
  );
  const [sampleNote, setSampleNote] = useState(`${keyword} 2000円`);
  const regexCheck = useMemo(() => compileNoteRegexForPreview(form.voucherNoteParseRegex), [form.voucherNoteParseRegex]);
  const regexError = regexCheck.error;
  const samplePreview = useMemo(() => {
    if (regexError) return "詳しい設定の「メモの読み方」を直すと試せます。";
    const face = parseVoucherFaceFromNote(sampleNote, keyword, regexCheck.regex);
    return face > 0 ? `このメモは額面 ${face.toLocaleString()} 円と読みます。` : "このメモからは額面を読めません。";
  }, [sampleNote, keyword, regexCheck, regexError]);

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
          ) : legacy && !actionData?.ok ? (
            <Layout.Section>
              <Banner tone="info" title="この設定はまだ精算に効いていません">
                <p>
                  一度「保存」を押すと、ここの設定と、同じ注文の自動判定と手入力を片方だけ数える決まりが効き始めます。保存するまでは今までどおり両方を足します。
                </p>
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
                  helpText="オフにすると、POS の「商品券釣銭登録」で登録できなくなり、登録済みの分も精算に数えません。"
                  checked={form.voucherManualAdjustmentEnabled}
                  onChange={(v) => set("voucherManualAdjustmentEnabled", v)}
                />
                <Checkbox
                  label="会計の前に額面を入れる"
                  helpText="POS の「商品券釣銭登録」タイルで会計の前に額面を入れると、会計のあとに商品券釣銭を自動で登録します。初めはオフです。"
                  checked={form.voucherCartEntryEnabled}
                  onChange={(v) => set("voucherCartEntryEnabled", v)}
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="注文メモの額面"
            description="スタッフが注文メモに商品券の額面を書いたとき、その額からお釣りを見つけます。"
          >
            <Card>
              <BlockStack gap="400">
                <Checkbox label="注文メモから額面を読み取る" checked={form.voucherNoteParseEnabled} onChange={(v) => set("voucherNoteParseEnabled", v)} />
                {form.voucherNoteParseEnabled ? (
                  <>
                    <ChoiceList
                      title="メモの書き方"
                      choices={[
                        {
                          label: `「${keyword} 2000円」のように書く`,
                          value: NOTE_FORMAT_STANDARD,
                          helpText: `例:「${keyword} 2000円」「${keyword}２，０００円」「${keyword}5000」。どれも額面として読みます。`,
                        },
                        {
                          label: "自分で決めた書き方",
                          value: NOTE_FORMAT_CUSTOM,
                          helpText: "下の「詳しい設定」の「メモの読み方」で決めます。",
                        },
                      ]}
                      selected={[noteFormat]}
                      onChange={(v) => {
                        const next = v[0] ?? NOTE_FORMAT_STANDARD;
                        setNoteFormat(next);
                        if (next === NOTE_FORMAT_STANDARD) set("voucherNoteParseRegex", "");
                      }}
                    />
                    <TextField label="メモの例で試す" value={sampleNote} onChange={setSampleNote} autoComplete="off" helpText={samplePreview} />
                  </>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="自動と手入力が重なったとき">
            <Card>
              <BlockStack gap="400">
                <ChoiceList
                  title="同じ注文に、自動で見つけた額と POS で手で入れた額の両方があるとき"
                  choices={PRIORITY_CHOICES}
                  selected={[form.voucherAdjustmentPriority]}
                  onChange={(v) => set("voucherAdjustmentPriority", (v[0] as "manual_first" | "auto_first") ?? "manual_first")}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  どちらか片方だけを数えるので、差額が 2 回足されることはありません（同じ日・同じ店の精算の中で）。
                </Text>
                <Checkbox label="精算に商品券のお釣りを反映する" checked={form.reflectVoucherChangeInSettlement} onChange={(v) => set("reflectVoucherChangeInSettlement", v)} />
                <Checkbox
                  label="納金金額から商品券の釣銭を引く"
                  helpText="商品券で払ったお客様にお釣りをレジの現金から渡した分を、精算の納金金額（現金）から引きます。支払方法別の現金の金額は変わりません。"
                  checked={form.deductVoucherChangeFromCashDeposit}
                  onChange={(v) => set("deductVoucherChangeFromCashDeposit", v)}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  精算レシートに差額の行を出すかは「精算レシート印字レイアウト」の「商品券釣有り差額行を含める」で決めます。
                </Text>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          {/* 詳しい設定は別の項目にまとめ、ふだん触る項目と分ける（開け閉めのボタンだけの行は作らない: UI_RULES 4章） */}
          <Layout.AnnotatedSection title="詳しい設定" description="ふつうは変えなくてかまいません。">
            <Card>
              <BlockStack gap="400">
                <TextField
                  label="商品券とみなす言葉"
                  helpText="注文メモや支払方法の名前にこの言葉があると商品券の注文とみなします。初めは「商品券」です。"
                  value={form.voucherDefaultLabel}
                  onChange={(v) => set("voucherDefaultLabel", v)}
                  autoComplete="off"
                />
                <TextField
                  label="メモの読み方（正規表現）"
                  helpText="「自分で決めた書き方」のときに使います。金額の部分を ( ) で囲みます。例: 額面=([0-9]+)"
                  value={form.voucherNoteParseRegex}
                  onChange={(v) => {
                    set("voucherNoteParseRegex", v);
                    setNoteFormat(v.trim() ? NOTE_FORMAT_CUSTOM : NOTE_FORMAT_STANDARD);
                  }}
                  error={regexError ?? undefined}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
