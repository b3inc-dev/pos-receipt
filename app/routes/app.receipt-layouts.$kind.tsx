/**
 * /app/receipt-layouts/:kind — 1 種類のレシートのレイアウトを編集する
 * 保存は Shopify の保存の帯（SaveBar）。1 回の保存でレイアウト全部を保存し、誤りが 1 つでもあれば何も保存しない。
 * 保存先: AppSetting（receipt_layout_v1_<kind>）。印字への接続は #22 が main に入ってから。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page, Layout } from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting, setAppSetting } from "../utils/appSettings.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { SaveBar, StatusBanner, SuccessToast } from "../components/admin-ui";
import { ReceiptLayoutEditor } from "../components/ReceiptLayoutEditor";
import {
  isReceiptKind,
  RECEIPT_KIND_LABELS,
  receiptLayoutSettingKey,
  type ReceiptLayout,
} from "../services/receiptLayoutSchema";
import { normalizeLayout, validateLayoutInput } from "../services/receiptLayoutValidate";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const kind = params.kind;
  if (!isReceiptKind(kind)) throw new Response("Not Found", { status: 404 });
  const shop = await resolveShop(session.shop, admin);
  const raw = await getAppSetting<unknown>(shop.id, receiptLayoutSettingKey(kind));
  return { kind, layout: normalizeLayout(raw, kind) };
}

type ActionData = { ok: true; layout: ReceiptLayout; savedAt: number } | { ok: false; errors: string[] };

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
  await setAppSetting(shop.id, receiptLayoutSettingKey(kind), result.layout);
  return { ok: true, layout: result.layout, savedAt: Date.now() };
}

export default function ReceiptLayoutEdit() {
  const { kind, layout: loaded } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const q = useLocation().search;

  // 保存した時点の値（「破棄」で戻す先）
  const [baseline, setBaseline] = useState<ReceiptLayout>(loaded);
  const [current, setCurrent] = useState<ReceiptLayout>(loaded);
  useEffect(() => {
    if (actionData?.ok) {
      setBaseline(actionData.layout);
      setCurrent(actionData.layout);
    }
  }, [actionData]);
  const hidden = useRef<HTMLInputElement | null>(null);
  const onDiscard = useCallback(() => {
    // baseline を作り直してエディタに戻させる
    setBaseline((b) => ({ ...b }));
    setCurrent(baseline);
  }, [baseline]);

  const saving = navigation.state === "submitting";
  const errors = actionData && !actionData.ok ? actionData.errors : null;

  return (
    <PolarisPageWrapper>
      <Page
        fullWidth
        title={RECEIPT_KIND_LABELS[kind]}
        subtitle="ブロックを並べ替えて、右のプレビューで印字の見た目を確かめます。"
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
              <input ref={hidden} type="hidden" name="layout" value={JSON.stringify(current)} readOnly />
              <SuccessToast message={actionData?.ok ? "保存しました" : null} trigger={actionData} />
              <SaveBar
                failed={Boolean(errors) && !saving}
                tone={errors ? "critical" : "success"}
                onDiscard={onDiscard}
              />
              <ReceiptLayoutEditor kind={kind} initial={baseline} onLayoutChange={setCurrent} />
            </Form>
          </Layout.Section>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
