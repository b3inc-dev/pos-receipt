/**
 * /app/footfall-sync — 入店数を ciara-system とそろえる（Ciara のカスタムアプリだけ）
 * 公開アプリ（自社用でない）では開けない（売上サマリー設定へ戻す）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page, Layout, Card, Text, BlockStack, InlineStack, Banner, Badge, Button, TextField, Checkbox } from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { ciaraBudgetSyncSecret } from "../services/ciaraBudgetSync.server";
import {
  ciaraVisitSyncAvailable,
  getCiaraVisitSyncSettings,
  runCiaraVisitSync,
  saveCiaraVisitSyncSettings,
} from "../services/ciaraVisitSync.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { SaveBar, SuccessToast, confirmLeave } from "../components/admin-ui";

type ActionResult = { ok: boolean; intent: string; message: string };

const BACK_PATH = "/app/sales-summary-settings/footfall";

function fmtJst(iso: string) {
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  if (!ciaraVisitSyncAvailable()) {
    const url = new URL(request.url);
    throw redirect(`${BACK_PATH}${url.search}`);
  }
  const shop = await resolveShop(session.shop, admin);
  const settings = await getCiaraVisitSyncSettings(shop.id);
  return { settings, hasSecret: Boolean(ciaraBudgetSyncSecret()) };
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const { admin, session } = await authenticate.admin(request);
  if (!ciaraVisitSyncAvailable()) {
    return Response.json({ ok: false, intent: "", message: "このアプリでは使えません" } satisfies ActionResult, { status: 404 });
  }
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  if (intent === "run") {
    const lastRun = await runCiaraVisitSync(shop.id, admin);
    return Response.json({ ok: lastRun.ok, intent, message: lastRun.message } satisfies ActionResult);
  }

  const endpointUrl = String(formData.get("endpointUrl") ?? "").trim();
  const enabled = formData.get("enabled") === "on";
  if (endpointUrl && !/^https:\/\//.test(endpointUrl)) {
    return Response.json({ ok: false, intent, message: "ciara-system の URL は https:// で始めてください" } satisfies ActionResult, { status: 400 });
  }
  if (enabled && !endpointUrl) {
    return Response.json({ ok: false, intent, message: "そろえるときは ciara-system の URL を入れてください" } satisfies ActionResult, { status: 400 });
  }
  const current = await getCiaraVisitSyncSettings(shop.id);
  await saveCiaraVisitSyncSettings(shop.id, { ...current, enabled, endpointUrl });
  return Response.json({ ok: true, intent, message: "保存しました" } satisfies ActionResult);
}

export default function FootfallSyncPage() {
  const { settings, hasSecret } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [endpointUrl, setEndpointUrl] = useState(settings.endpointUrl);
  const running = navigation.state === "submitting" && navigation.formData?.get("intent") === "run";
  const last = settings.lastRun;

  const back = () => void confirmLeave().then(() => navigate(`${BACK_PATH}${location.search}`));

  // お知らせ枠は 1 つ（失敗のときだけ）
  let notice: { title: string; text: string } | null = null;
  if (actionData && !actionData.ok) {
    notice = { title: actionData.intent === "run" ? "そろえられませんでした" : "保存できませんでした", text: actionData.message };
  }
  // つながりの状態（サーバーの設定の名前は出さない）
  const connected = hasSecret && settings.enabled && Boolean(last?.ok);
  const connectionNote = connected
    ? last?.receiveOff
      ? "ciara-system の入店数はこちらに入ります。ciara-system で受け取りがオフなので、POS で入れた数は ciara-system にはまだ送っていません。"
      : "10 分ごとにそろえています。POS で報告した数は、その場で ciara-system にも送ります。"
    : !settings.enabled
      ? "そろえるをオンにして保存すると、つながりを確かめます。"
      : !hasSecret
        ? "サーバーの準備がまだです。準備ができると 10 分ごとにそろえます。"
        : last && !last.ok
          ? last.message
          : "「今すぐそろえる」を押すと、つながりを確かめます。";

  return (
    <PolarisPageWrapper>
      <Page
        title="ciara-system と入店数をそろえる"
        subtitle="POS と ciara-system のどちらで入店数を報告しても、あとから入れた数が両方に出るようにします。"
        backAction={{ content: "入店数の報告", onAction: back }}
      >
        <SuccessToast
          message={actionData?.ok ? (actionData.intent === "run" ? actionData.message : "保存しました") : null}
          trigger={actionData}
        />
        <Layout>
          {notice && (
            <Layout.Section>
              <Banner tone="critical" title={notice.title}>
                <Text as="p">{notice.text}</Text>
              </Banner>
            </Layout.Section>
          )}

          <Layout.AnnotatedSection
            title="そろえる設定"
            description="今日を含めた前の 35 日の入店数を、Shopify のロケーションが同じ店どうしでそろえます。同じ店・同じ日は、あとから入れた数を採ります。"
          >
            <Card>
              <Form method="post" className="Admin-form">
                <input type="hidden" name="intent" value="save" />
                <SaveBar
                  failed={Boolean(actionData && !actionData.ok && actionData.intent === "save")}
                  onDiscard={() => {
                    setEnabled(settings.enabled);
                    setEndpointUrl(settings.endpointUrl);
                  }}
                />
                <BlockStack gap="300">
                  <Checkbox
                    label="ciara-system と入店数をそろえる"
                    helpText="オンの間も、POS からいつもどおり入店数を報告できます。ciara-system で入れた数も POS の売上サマリーに出ます。"
                    name="enabled"
                    checked={enabled}
                    onChange={setEnabled}
                  />
                  <TextField
                    label="ciara-system の入店数の URL"
                    name="endpointUrl"
                    value={endpointUrl}
                    onChange={setEndpointUrl}
                    autoComplete="off"
                    placeholder="https://…/api/external/pos-receipt/visits"
                  />
                </BlockStack>
              </Form>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="前回のそろえ" description="10 分ごとに動きます。すぐにそろえたいときは「今すぐそろえる」を押します。">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="headingSm">ciara-system とのつながり</Text>
                  <Badge tone={connected ? "success" : "attention"}>{connected ? "つながっています" : "まだです"}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">{connectionNote}</Text>
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  {last ? (
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone={last.ok ? "success" : "critical"}>{last.ok ? "完了" : "失敗"}</Badge>
                      <Text as="span">{fmtJst(last.at)}</Text>
                    </InlineStack>
                  ) : (
                    <Text as="span" tone="subdued">まだそろえていません</Text>
                  )}
                  <Form method="post">
                    <input type="hidden" name="intent" value="run" />
                    <Button submit loading={running} disabled={!settings.enabled || !hasSecret}>
                      今すぐそろえる
                    </Button>
                  </Form>
                </InlineStack>
                {last && (
                  <BlockStack gap="100">
                    <Text as="p">{last.message}</Text>
                    {last.unmatched.length > 0 && (
                      <Text as="p" tone="caution">
                        このストアに同じロケーションが無いのでそろえなかった店: {last.unmatched.join("・")}
                      </Text>
                    )}
                    {last.skipped.length > 0 && (
                      <Text as="p" tone="caution">
                        ciara-system で入店数報告の店になっていないので送れなかった店: {last.skipped.join("・")}
                      </Text>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </Page>
    </PolarisPageWrapper>
  );
}
