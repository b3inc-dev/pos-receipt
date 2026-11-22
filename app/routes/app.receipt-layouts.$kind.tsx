/**
 * /app/receipt-layouts/:kind — 1 種類のレシートのレイアウトを編集する
 * 保存は Shopify の保存の帯（SaveBar）。1 回の保存でレイアウト全部を保存し、誤りが 1 つでもあれば何も保存しない。
 * 保存先: AppSetting（receipt_layout_v1_<kind>）。「このレイアウトで印字する」は receipt_layout_print_v1。
 * 印字に使うのは「このレイアウトで印字する」を入れた種類だけ（入れていなければ今までの印字）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page, Layout, Card, Checkbox, BlockStack, Text, Link } from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting, setAppSetting } from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { SaveBar, StatusBanner, SuccessToast, markFormDirty } from "../components/admin-ui";
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
  const [raw, enabled] = await Promise.all([
    getAppSetting<unknown>(shop.id, receiptLayoutSettingKey(kind)),
    getLayoutPrintEnabled(shop.id),
  ]);
  // 精算のプレビューは、店の支払方法の並び順・まとめの行・納金額の設定を入れた見本で出す
  const sampleData = kind === "settlement" ? sampleSettlementData(await getSettlementCalc(shop.id)) : undefined;
  return { kind, layout: normalizeLayout(raw, kind), printEnabled: enabled[kind], sampleData };
}

type ActionData =
  | { ok: true; layout: ReceiptLayout; printEnabled: boolean; savedAt: number }
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
  await setAppSetting(shop.id, receiptLayoutSettingKey(kind), result.layout);
  const enabled = await getLayoutPrintEnabled(shop.id);
  await setAppSetting(shop.id, LAYOUT_PRINT_ENABLED_KEY, { ...enabled, [kind]: printEnabled });
  return { ok: true, layout: result.layout, printEnabled, savedAt: Date.now() };
}

export default function ReceiptLayoutEdit() {
  const { kind, layout: loaded, printEnabled: loadedEnabled, sampleData } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const q = useLocation().search;

  // 保存した時点の値（「破棄」で戻す先）
  const [baseline, setBaseline] = useState<ReceiptLayout>(loaded);
  const [current, setCurrent] = useState<ReceiptLayout>(loaded);
  const [enabledBaseline, setEnabledBaseline] = useState(loadedEnabled);
  const [printEnabled, setPrintEnabled] = useState(loadedEnabled);
  const enabledInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (actionData?.ok) {
      setBaseline(actionData.layout);
      setCurrent(actionData.layout);
      setEnabledBaseline(actionData.printEnabled);
      setPrintEnabled(actionData.printEnabled);
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
  }, [baseline, enabledBaseline]);

  const saving = navigation.state === "submitting";
  const errors = actionData && !actionData.ok && !errorsDismissed ? actionData.errors : null;

  return (
    <PolarisPageWrapper>
      <Page
        fullWidth
        title={RECEIPT_KIND_LABELS[kind]}
        subtitle="ブロックを並べ替えて、プレビューで印字の見た目を確かめます。"
        backAction={{ content: "レシートのレイアウト", onAction: () => navigate("/app/receipt-layouts" + q) }}
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
              <input ref={enabledInput} type="hidden" name="printEnabled" value={printEnabled ? "1" : "0"} readOnly />
              <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
              <SaveBar
                failed={Boolean(errors) && !saving}
                tone={errors ? "critical" : "success"}
                onDiscard={onDiscard}
              />
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="200">
                    <Checkbox
                      label="このレイアウトで印字する"
                      helpText={
                        printEnabled
                          ? "保存すると、次の印字からこのレイアウトになります。作れなかったときは今までの印字で出します。"
                          : "オフのあいだは今までの印字のままです。プレビューを見ながら作り、できたらオンにして保存します。"
                      }
                      checked={printEnabled}
                      onChange={(v) => {
                        setPrintEnabled(v);
                        // hidden の値が変わってから帯の判定をさせる
                        window.setTimeout(() => markFormDirty(enabledInput.current), 0);
                      }}
                    />
                    {kind === "settlement" || kind === "sales" ? (
                      <Text as="p" tone="subdued">
                        {kind === "settlement"
                          ? "支払方法の並び順・電子マネー(合計) などのまとめの行・納金額の計算は "
                          : "スタッフ名を探す明細のプロパティは "}
                        <Link url={`/app/receipt-layouts/print-data${q}`}>印字の値の設定</Link>
                        で変えます。
                      </Text>
                    ) : null}
                  </BlockStack>
                </Card>
                <ReceiptLayoutEditor kind={kind} initial={baseline} onLayoutChange={setCurrent} sampleData={sampleData} />
              </BlockStack>
            </Form>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
