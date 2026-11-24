import { getReceiptDesignBasics, saveReceiptDesign, DesignSettingsConflict } from "../services/receiptDesignSettings.server";
import { normalizeDesignBasics, scopedDesignBasics, validateDesignBasics, type ReceiptDesignBasics as Basics } from "../services/receiptDesignSettings";
import { ReceiptDesignBasics } from "../components/ReceiptDesignBasics";
import { ReceiptLayoutPreview } from "../components/ReceiptLayoutPreview";
import { standardDesignPreview } from "../services/receiptDesignPreview";
import { applyPrinterProfile, printerGeometry } from "../services/receiptPrinterProfile";
import { paperWidthPx } from "../services/receiptLayoutRender";
import { normalizePrinterProfile } from "../services/receiptPrinterProfile";
/**
 * /app/receipt-layouts/:kind — 1 種類のレシートのレイアウトを編集する
 * 保存は Shopify の保存の帯（SaveBar）。1 回の保存でレイアウト全部を保存し、誤りが 1 つでもあれば何も保存しない。
 * 保存先: AppSetting（receipt_layout_v1_<kind>）。「このレイアウトで印字する」は receipt_layout_print_v1。
 * 印字に使うのは「このレイアウトで印字する」を入れた種類だけ（入れていなければ今までの印字）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page, Layout, Card, Select, BlockStack, Text, Button, InlineStack } from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting, setAppSetting, PRINT_SETTINGS_KEY, type PrintSettings } from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { SaveBar, StatusBanner, SuccessToast, useGuardedNavigate } from "../components/admin-ui";
import { ReceiptLayoutEditor } from "../components/ReceiptLayoutEditor";
import {
  isReceiptKind,
  RECEIPT_KIND_LABELS,
  receiptLayoutSettingKey,
  canonicalLayout,
  type ReceiptLayout,
} from "../services/receiptLayoutSchema";
import { normalizeLayout, validateLayoutInput } from "../services/receiptLayoutValidate";
import {
  getLayoutPrintEnabled,
  getSettlementCalc,
  LAYOUT_PRINT_ENABLED_KEY,
} from "../services/receiptLayoutPrint.server";
import { sampleSettlementData } from "../services/receiptLayoutAdapters";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const kind = params.kind;
  if (!isReceiptKind(kind)) throw new Response("Not Found", { status: 404 });
  const shop = await resolveShop(session.shop, admin);
  const [raw, enabled, printSettings] = await Promise.all([
    getAppSetting<unknown>(shop.id, receiptLayoutSettingKey(kind)),
    getLayoutPrintEnabled(shop.id),
    getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY),
  ]);
  // 精算のプレビューは、店の支払方法の並び順・まとめの行・納金額の設定を入れた見本で出す
  const sampleData = kind === "settlement" ? sampleSettlementData(await getSettlementCalc(shop.id)) : undefined;
  const basics = await getReceiptDesignBasics(shop.id, kind);
  return { basics, printerProfile: normalizePrinterProfile(printSettings?.receiptPrinterProfile), kind, layout: { ...normalizeLayout(raw, kind), paperWidthMm: basics.paperWidthMm }, printEnabled: enabled[kind], sampleData };
}

type ActionData =
  | { ok: true; layout: ReceiptLayout; printEnabled: boolean; basics?: Basics; savedAt: number }
  | { ok: false; errors: string[] };

export async function action({ request, params }: ActionFunctionArgs): Promise<ActionData> {
  const { admin, session } = await authenticate.admin(request);
  const kind = params.kind;
  if (!isReceiptKind(kind)) throw new Response("Not Found", { status: 404 });
  const shop = await resolveShop(session.shop, admin);
  const form = await request.formData();
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("layout") ?? ""));
  } catch {
    return { ok: false, errors: ["レイアウトを読み取れませんでした。画面を開き直してください。"] };
  }
  const result = validateLayoutInput(raw, kind);
  if (!result.ok) {
    console.warn("[receipt-layout] save rejected", { kind, errors: result.errors.length });
    return { ok: false, errors: result.errors };
  }
  const printEnabled = form.get("printEnabled") === "1";
  let basics: Basics | undefined;
  let baseline: Basics | undefined;
  if (form.has("basics")) {
    try {
      const input = JSON.parse(String(form.get("basics")));
      const errors = validateDesignBasics(input, kind);
      if (errors.length) return { ok: false, errors };
      basics = normalizeDesignBasics(input, kind);
      const original = JSON.parse(String(form.get("baselineBasics")));
      const originalErrors = validateDesignBasics(original, kind);
      if (originalErrors.length) return { ok: false, errors: originalErrors };
      baseline = normalizeDesignBasics(original, kind);
    } catch { return { ok: false, errors: ["基本設定を読み取れませんでした。画面を開き直してください。"] }; }
  }
  try {
    await saveReceiptDesign(shop.id, kind, result.layout, printEnabled, basics, baseline);
  } catch (error) {
    return { ok: false, errors: [error instanceof DesignSettingsConflict ? error.message : "設定を保存できませんでした。時間をおいてもう一度お試しください。"] };
  }
  return { ok: true, layout: result.layout, printEnabled, basics, savedAt: Date.now() };
}

export default function ReceiptLayoutEdit() {
  const { kind, layout: loaded, printEnabled: loadedEnabled, sampleData, printerProfile, basics: loadedBasics } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const navigate = useGuardedNavigate();
  const q = useLocation().search;

  // 保存した時点の値（「破棄」で戻す先）
  const [baseline, setBaseline] = useState<ReceiptLayout>(loaded);
  const [current, setCurrent] = useState<ReceiptLayout>(loaded);
  const [enabledBaseline, setEnabledBaseline] = useState(loadedEnabled);
  const [printEnabled, setPrintEnabled] = useState(loadedEnabled);
  const [basicsBaseline, setBasicsBaseline] = useState(loadedBasics);
  const [basics, setBasics] = useState(loadedBasics);
  useEffect(() => {
    if (actionData?.ok) {
      setBaseline(actionData.layout);
      setCurrent(actionData.layout);
      setEnabledBaseline(actionData.printEnabled);
      setPrintEnabled(actionData.printEnabled);
      if (actionData.basics) { setBasicsBaseline(actionData.basics); setBasics(actionData.basics); }
    }
  }, [actionData]);
  const hidden = useRef<HTMLInputElement | null>(null);
  // 「破棄」したら前の保存の失敗の枠も消す
  const [errorsDismissed, setErrorsDismissed] = useState(false);
  useEffect(() => setErrorsDismissed(false), [actionData]);
  const onDiscard = useCallback(() => {
    setErrorsDismissed(true);
    // baseline を作り直してエディタに戻させる
    setBaseline((b) => ({ ...b }));
    setCurrent(baseline);
    setPrintEnabled(enabledBaseline);
    setBasics(basicsBaseline);
  }, [baseline, enabledBaseline, basicsBaseline]);

  const saving = navigation.state === "submitting";
  const errors = actionData && !actionData.ok && !errorsDismissed ? actionData.errors : null;

  return (
    <PolarisPageWrapper wide>
      <Page
        fullWidth
        title={RECEIPT_KIND_LABELS[kind]}
        subtitle="基本設定・デザイン・印字の見本を、この画面で確認して保存します。"
        backAction={{ content: "レシートのデザイン", onAction: () => navigate("/app/receipt-layouts" + q) }}
      >
        <Layout>
          {errors ? (
            <Layout.Section>
              <StatusBanner tone="critical" heading="保存できませんでした">
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </StatusBanner>
            </Layout.Section>
          ) : null}
          <Layout.Section>
            <Form method="post">
              <input ref={hidden} type="hidden" name="layout" value={JSON.stringify(canonicalLayout(current))} readOnly />
              <input type="hidden" name="printEnabled" value={printEnabled ? "1" : "0"} readOnly />
              <input type="hidden" name="basics" value={JSON.stringify(basics)} readOnly />
              <input type="hidden" name="baselineBasics" value={JSON.stringify(basicsBaseline)} readOnly />
              <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
              <SaveBar
                hasChanges={!saving && (JSON.stringify(canonicalLayout(current)) !== JSON.stringify(canonicalLayout(baseline)) || printEnabled !== enabledBaseline || JSON.stringify(scopedDesignBasics(basics, kind)) !== JSON.stringify(scopedDesignBasics(basicsBaseline, kind)))}
                failed={Boolean(errors) && !saving}
                tone={errors ? "critical" : "success"}
                onDiscard={onDiscard}
              />
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="200">
                    <Select label="使うデザイン" options={[{ label: "標準デザイン", value: "standard" }, { label: "作成したデザイン（ブロック・コード）", value: "custom" }]}
                      value={printEnabled ? "custom" : "standard"} onChange={(v) => setPrintEnabled(v === "custom")}
                      helpText="選んで保存すると次の印字から使います。作成したデザインとコードは、標準に切り替えても残ります。" />
                    {kind === "settlement" || kind === "sales" ? (
                      <InlineStack gap="200" blockAlign="center" wrap>
                        <Text as="p" tone="subdued">
                          {kind === "settlement"
                            ? "支払方法の並び順・まとめの行（電子マネー(合計) など）・納金額の計算"
                            : "スタッフ名を探す明細のプロパティ"}
                        </Text>
                        <Button onClick={() => navigate(`/app/receipt-layouts/print-data${q}`)}>印字の値の設定</Button>
                      </InlineStack>
                    ) : null}
                  </BlockStack>
                </Card>
                <ReceiptDesignBasics kind={kind} value={basics} custom={printEnabled} onChange={(next) => {
                  setBasics(next); setCurrent((prev) => ({ ...prev, paperWidthMm: next.paperWidthMm }));
                }} />
                <div hidden={!printEnabled}><ReceiptLayoutEditor kind={kind} initial={baseline} onLayoutChange={setCurrent}
                  sampleData={kind === "settlement" && sampleData?.kind === "settlement" ? { ...sampleData, settlement: {
                    ...sampleData.settlement, title: basics.isInspection ? "点検" : sampleData.settlement.title,
                    kind_label: basics.isInspection ? "点検" : "精算", is_inspection: !!basics.isInspection,
                    voucher_change: basics.showVoucherChange ? sampleData.settlement.voucher_change : 0,
                  } } : sampleData} printerProfile={printerProfile} paperWidthMm={basics.paperWidthMm} active={printEnabled} /></div>
                {!printEnabled ? <Card><BlockStack gap="300"><Text as="h2" variant="headingMd">標準デザインのプレビュー</Text>
                    <ReceiptLayoutPreview html={applyPrinterProfile(standardDesignPreview(kind, basics), printerProfile, basics.paperWidthMm)}
                      widthPx={paperWidthPx(basics.paperWidthMm)} viewportPx={printerGeometry(printerProfile, basics.paperWidthMm).viewportPx ?? paperWidthPx(basics.paperWidthMm)}
                      horizontalScale={printerGeometry(printerProfile, basics.paperWidthMm).horizontalScale} />
                  </BlockStack></Card> : null}

              </BlockStack>
            </Form>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
