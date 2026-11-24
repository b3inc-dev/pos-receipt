/**
 * /app/budget-sync — ciara-system の予算の取り込み（Ciara のカスタムアプリだけ）
 * 公開アプリ（自社用でない）では開けない（予算管理へ戻す）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page, Layout, Card, Text, BlockStack, InlineStack, Banner, Badge, Button, Checkbox } from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import {
  ciaraBudgetSyncAvailable,
  ciaraSyncServerReady,
  getCiaraBudgetSyncSettings,
  runCiaraBudgetSync,
  saveCiaraBudgetSyncSettings,
  ensureCiaraBudgetSyncScheduler,
  ciaraBudgetSyncSchedulerStatus,
} from "../services/ciaraBudgetSync.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { SaveBar, SuccessToast, confirmLeave } from "../components/admin-ui";

type ActionResult = { ok: boolean; intent: string; message: string };

function fmtJst(iso: string) {
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  if (!ciaraBudgetSyncAvailable()) {
    const url = new URL(request.url);
    throw redirect(`/app/budget-management${url.search}`);
  }
  const shop = await resolveShop(session.shop, admin);
  const settings = await getCiaraBudgetSyncSettings(shop.id);
  // 定期の仕事が止まっていたら、開いたときにもう一度始める（待たずに今の状態を出す）
  void ensureCiaraBudgetSyncScheduler();
  return { settings, hasSecret: ciaraSyncServerReady(), schedulerState: ciaraBudgetSyncSchedulerStatus().state };
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const { admin, session } = await authenticate.admin(request);
  if (!ciaraBudgetSyncAvailable()) {
    return Response.json({ ok: false, intent: "", message: "このアプリでは使えません" } satisfies ActionResult, { status: 404 });
  }
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  if (intent === "run") {
    const lastRun = await runCiaraBudgetSync(shop.id, admin);
    return Response.json({ ok: Boolean(lastRun?.ok), intent, message: lastRun?.message ?? "" } satisfies ActionResult);
  }

  // Polaris の Checkbox は値を空で送るので、隠し入力の true / false で受ける（ほかの設定画面と同じ形）
  const enabled = formData.get("enabled") === "true";
  const current = await getCiaraBudgetSyncSettings(shop.id);
  await saveCiaraBudgetSyncSettings(shop.id, { ...current, enabled });
  return Response.json({ ok: true, intent, message: "保存しました" } satisfies ActionResult);
}

export default function BudgetSyncPage() {
  const { settings, hasSecret, schedulerState } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const [enabled, setEnabled] = useState(settings.enabled);
  const running = navigation.state === "submitting" && navigation.formData?.get("intent") === "run";
  const last = settings.lastRun;

  const back = () => void confirmLeave().then(() => navigate(`/app/budget-management${location.search}`));

  // お知らせ枠は 1 つ（失敗のときだけ）
  let notice: { tone: "critical"; title: string; text: string } | null = null;
  if (actionData && !actionData.ok) {
    notice = { tone: "critical", title: actionData.intent === "run" ? "取り込めませんでした" : "保存できませんでした", text: actionData.message };
  }
  // つながりの状態（サーバーの設定の名前は出さない）
  // 定期の仕事が止まっているときは「つながっています」にしない（黙って止まらない）
  const jobStopped = hasSecret && settings.enabled && schedulerState === "failed";
  const jobStarting = hasSecret && settings.enabled && schedulerState === "starting";
  const connected = hasSecret && settings.enabled && Boolean(last?.ok) && !jobStopped;
  const connectionNote = jobStopped
    ? "1 時間ごとの取り込みが止まっています。5 分ほどで自動でもう一度始めます。続くときは連絡してください。"
    : jobStarting && !connected
      ? "1 時間ごとの取り込みを始めています。少しして再読み込みしてください。"
      : connected
        ? "1 時間ごとに取り込んでいます。"
        : !settings.enabled
          ? "取り込みをオンにして保存すると、つながりを確かめます。"
          : !hasSecret
            ? "サーバーの準備がまだです。準備ができると 1 時間ごとに取り込みます。"
            : last && !last.ok
              ? last.message
              : "「今すぐ取り込む」を押すと、つながりを確かめます。";

  return (
    <PolarisPageWrapper>
      <Page
        title="ciara-system から予算を取り込む"
        subtitle="ciara-system の店舗ごとの日別予算を、1 時間ごとにこのアプリの予算へ取り込みます。"
        backAction={{ content: "予算管理", onAction: back }}
      >
        <SuccessToast
          message={actionData?.ok ? (actionData.intent === "run" ? actionData.message : "保存しました") : null}
          trigger={actionData}
        />
        <Layout>
          {notice && (
            <Layout.Section>
              <Banner tone={notice.tone} title={notice.title}>
                <Text as="p">{notice.text}</Text>
              </Banner>
            </Layout.Section>
          )}

          <Layout.AnnotatedSection
            title="取り込みの設定"
            description="今月と来月の分を読み、Shopify のロケーションが同じ店の予算を ciara-system の値に合わせます。日別予算が無い日は、月の予算を日数で割った額になります。"
          >
            <Card>
              <Form method="post" className="Admin-form">
                <input type="hidden" name="intent" value="save" />
                <SaveBar
                  failed={Boolean(actionData && !actionData.ok && actionData.intent === "save")}
                  onDiscard={() => {
                    setEnabled(settings.enabled);
                  }}
                />
                <BlockStack gap="300">
                  <input type="hidden" name="enabled" value={enabled ? "true" : "false"} />
                  <Checkbox
                    label="ciara-system から予算を取り込む"
                    helpText="オンの間、取り込んだ店の予算はこのアプリでは見るだけになります（入力は ciara-system で行います）。"
                    checked={enabled}
                    onChange={setEnabled}
                  />
                </BlockStack>
              </Form>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection title="前回の取り込み" description="1 時間ごと（毎時 7 分）に動きます。すぐに合わせたいときは「今すぐ取り込む」を押します。">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="headingSm">ciara-system とのつながり</Text>
                  <Badge tone={jobStopped ? "critical" : connected ? "success" : "attention"}>{jobStopped ? "止まっています" : connected ? "つながっています" : "まだです"}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">{connectionNote}</Text>
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  {last ? (
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone={last.ok ? "success" : "critical"}>{last.ok ? "完了" : "失敗"}</Badge>
                      <Text as="span">{fmtJst(last.at)}</Text>
                    </InlineStack>
                  ) : (
                    <Text as="span" tone="subdued">まだ取り込んでいません</Text>
                  )}
                  <Form method="post">
                    <input type="hidden" name="intent" value="run" />
                    <Button submit loading={running} disabled={!settings.enabled || !hasSecret}>
                      今すぐ取り込む
                    </Button>
                  </Form>
                </InlineStack>
                {last && (
                  <BlockStack gap="100">
                    <Text as="p">{last.message}</Text>
                    {last.ok && <Text as="p" tone="subdued">取り込んだ店: {last.stores} 店</Text>}
                    {last.unmatched.length > 0 && (
                      <Text as="p" tone="caution">
                        このストアに同じロケーションが無いので取り込まなかった店: {last.unmatched.join("・")}
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
