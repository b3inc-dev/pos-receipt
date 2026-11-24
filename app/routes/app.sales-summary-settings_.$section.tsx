/**
 * /app/sales-summary-settings/:section — 売上サマリー設定の区分ごとの編集
 *
 * basic（使い方）・display（出す店と行）・numbers（出す数字）・footfall（入店数の報告）は保存の帯で保存する。
 * 保存はその区分の項目だけを書き換え、ほかの区分はそのまま（readSectionForm）。
 * link（ブラウザで見るリンク）は設定ではなく操作なので、ボタンで発行・止める・パスワードを決める。
 */
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { generateSalesSummaryPublicToken, hashSalesSummaryPublicToken } from "../utils/salesSummaryPublicToken.server";
import { hashPublicSummaryPassword } from "../utils/salesSummaryPublicAuth.server";
import { setAppSetting, SALES_SUMMARY_SETTINGS_KEY, type SalesSummarySettings } from "../utils/appSettings.server";
import { loadSalesSummarySettingsPage } from "../utils/salesSummarySettings.server";
import {
  BASIC_CHECKS,
  DISPLAY_CHECKS,
  FOOTFALL_CHECKS,
  NUMBER_CHECKS,
  SECTION_DESCRIPTIONS,
  SECTION_TITLES,
  isSectionKey,
  readSectionForm,
  type SalesSummarySectionKey,
} from "../utils/salesSummarySettingsSections";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { StoreBody } from "../components/StoreBody";
import { AdminBlock, ConfirmAction, PickList, SaveBar, SecondaryLink, StateBadge, StatusBanner, SuccessToast } from "../components/admin-ui";
import { withSearch } from "../utils/withSearch";

function sectionOf(value: string | undefined): SalesSummarySectionKey {
  if (!isSectionKey(value)) throw new Response("この設定はありません", { status: 404 });
  return value;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const section = sectionOf(params.section);
  const { admin, session } = await authenticate.admin(request);
  const { settings, locations, link } = await loadSalesSummarySettingsPage(admin, session.shop);
  // ciara-system と入店数を見せ合う（Ciara のカスタムアプリだけ）
  const { ciaraVisitSyncAvailable } = await import("../services/ciaraVisitSync.server");
  return { section, settings, locations, link, ciaraVisitSync: section === "footfall" && ciaraVisitSyncAvailable() };
}

type ActionResult =
  | { ok: true; at: number; message: string; issuedUrl?: string }
  | { ok: false; at: number; error: string };

export async function action({ request, params }: ActionFunctionArgs): Promise<ActionResult> {
  const section = sectionOf(params.section);
  const { admin, session } = await authenticate.admin(request);
  const { shop, settings, locations } = await loadSalesSummarySettingsPage(admin, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");
  const at = Date.now();

  if (section !== "link") {
    const next: SalesSummarySettings = { ...settings, ...readSectionForm(section, form, locations.map((l) => l.id)) };
    try {
      await setAppSetting(shop.id, SALES_SUMMARY_SETTINGS_KEY, next);
    } catch (error) {
      console.error("[sales-summary-settings] save failed", error);
      return { ok: false, at, error: "保存できませんでした。少し待ってからもう一度保存してください。" };
    }
    return { ok: true, at, message: "保存しました" };
  }

  if (intent === "issue") {
    const fullAccess = await getFullAccess(admin, { shop: shop.shopDomain });
    const access = checkPlanAccess(shop.planCode, "sales_summary", fullAccess);
    if (!access.allowed) return { ok: false, at, error: access.message || "今のプランでは使えません。" };
    const plain = generateSalesSummaryPublicToken();
    await prisma.shop.update({ where: { id: shop.id }, data: { salesSummaryPublicTokenHash: hashSalesSummaryPublicToken(plain) } });
    const baseUrl = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
    return { ok: true, at, message: "リンクを発行しました", issuedUrl: `${baseUrl}/p/sales-summary/${encodeURIComponent(plain)}` };
  }
  if (intent === "revoke") {
    await prisma.shop.update({ where: { id: shop.id }, data: { salesSummaryPublicTokenHash: null } });
    return { ok: true, at, message: "リンクを止めました" };
  }
  if (intent === "setPassword") {
    const pwd = String(form.get("password") ?? "").trim();
    const confirm = String(form.get("passwordConfirm") ?? "").trim();
    if (pwd.length < 4) return { ok: false, at, error: "パスワードは 4 文字以上にしてください。" };
    if (pwd.length > 128) return { ok: false, at, error: "パスワードは 128 文字以内にしてください。" };
    if (pwd !== confirm) return { ok: false, at, error: "確認のパスワードが同じではありません。" };
    await prisma.shop.update({ where: { id: shop.id }, data: { salesSummaryPublicPasswordScrypt: hashPublicSummaryPassword(pwd) } });
    return { ok: true, at, message: "パスワードを保存しました" };
  }
  if (intent === "clearPassword") {
    await prisma.shop.update({ where: { id: shop.id }, data: { salesSummaryPublicPasswordScrypt: null } });
    return { ok: true, at, message: "パスワードを外しました" };
  }
  return { ok: false, at, error: "操作が分かりませんでした。画面を開き直してください。" };
}

export default function SalesSummarySectionPage() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const q = useLocation().search || "";
  const busy = navigation.state === "submitting";
  const failed = !busy && Boolean(result && !result.ok);
  return (
    <PolarisPageWrapper>
      <Page
        title={SECTION_TITLES[data.section]}
        subtitle="売上サマリー設定"
        backAction={{ content: "売上サマリー設定", onAction: () => navigate(withSearch("/app/sales-summary-settings", q)) }}
      >
        <StoreBody>
          <SuccessToast trigger={result?.at} message={result?.ok ? result.message : null} />
          {failed && result && !result.ok ? <StatusBanner tone="critical" heading="できませんでした">{result.error}</StatusBanner> : null}
          {data.section === "link" ? (
            <LinkSection data={data} issuedUrl={result?.ok ? result.issuedUrl : undefined} busy={busy} />
          ) : (
            <SettingsForm key={data.section} data={data} failed={failed} />
          )}
        </StoreBody>
      </Page>
    </PolarisPageWrapper>
  );
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

function Checks({ items, values }: { items: { key: string; label: string; help?: string }[]; values: Record<string, unknown> }) {
  return (
    <>
      {items.map((item) => (
        <label key={item.key}>
          <input type="checkbox" name={item.key} defaultChecked={values[item.key] === true} />
          <span>
            {item.label}
            {item.help ? <span className="Admin-note" style={{ display: "block" }}>{item.help}</span> : null}
          </span>
        </label>
      ))}
    </>
  );
}

function SettingsForm({ data, failed }: { data: Data; failed: boolean }) {
  const q = useLocation().search || "";
  const s = data.settings as unknown as Record<string, unknown> & SalesSummarySettings;
  const [footfall, setFootfall] = useState<string[]>(data.settings.footfallTargetLocationIds);
  const discard = () => {
    setFootfall(data.settings.footfallTargetLocationIds);
  };
  const stores = data.locations.map((l) => ({ id: l.id, name: l.name }));
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="save" />
      {data.section === "basic" ? (
        <>
          <AdminBlock title="使い方" description={SECTION_DESCRIPTIONS.basic}>
            <Checks items={BASIC_CHECKS} values={s} />
          </AdminBlock>
          <AdminBlock title="週の始まり" description="「今週」「先週」と、期間を選ぶときの初めの値に使います。">
            <label>
              <input type="radio" name="weekStartsOn" value="monday" defaultChecked={s.weekStartsOn !== "sunday"} />
              <span>月曜から日曜まで</span>
            </label>
            <label>
              <input type="radio" name="weekStartsOn" value="sunday" defaultChecked={s.weekStartsOn === "sunday"} />
              <span>日曜から土曜まで</span>
            </label>
          </AdminBlock>
        </>
      ) : null}
      {data.section === "display" ? (
        <>
          <AdminBlock title="出す行" description={SECTION_DESCRIPTIONS.display}>
            <Checks items={DISPLAY_CHECKS} values={s} />
          </AdminBlock>
          <AdminBlock title="出す店" description="出す店は、店舗の設定の「売上サマリーで集計する」で決めます。">
            <SecondaryLink to={withSearch("/app/settings", q)}>店舗の設定を開く</SecondaryLink>
          </AdminBlock>
        </>
      ) : null}
      {data.section === "numbers" ? (
        <AdminBlock title="出す数字" description={SECTION_DESCRIPTIONS.numbers}>
          <Checks items={NUMBER_CHECKS} values={s} />
          <label>
            ポイント利用額の名前
            <input name="loyaltyUsageSummaryLabel" defaultValue={s.loyaltyUsageSummaryLabel} maxLength={30} autoComplete="off" />
          </label>
        </AdminBlock>
      ) : null}
      {data.section === "footfall" ? (
        <>
          <AdminBlock title="入店数の報告" description={SECTION_DESCRIPTIONS.footfall}>
            <label>
              <input type="checkbox" name="footfallReportingEnabled" defaultChecked={s.footfallReportingEnabled} />
              <span>入店数を報告できるようにする</span>
            </label>
            <Checks items={FOOTFALL_CHECKS} values={s} />
          </AdminBlock>
          <AdminBlock title="報告する店" description="選んだ店の POS だけで報告できます。「すべての店」なら、あとから足した店も報告できます。">
            <PickList label="報告する店" items={stores} value={footfall} onChange={setFootfall} allLabel="すべての店" name="footfallTargetLocationIds" />
          </AdminBlock>
          {data.ciaraVisitSync ? (
            <AdminBlock title="ciara-system と見せ合う" description="POS と ciara-system のどちらで報告しても、あとから入れた入店数が両方に出るようにします。">
              <div>
                <SecondaryLink to={withSearch("/app/footfall-sync", q)}>
                  見せ合う設定
                </SecondaryLink>
              </div>
            </AdminBlock>
          ) : null}
        </>
      ) : null}
      <SaveBar failed={failed} onDiscard={discard} />
    </Form>
  );
}

function LinkSection({ data, issuedUrl, busy }: { data: Data; issuedUrl?: string; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <AdminBlock title="リンク" description={SECTION_DESCRIPTIONS.link}>
        <p>
          今: {data.link.active ? <StateBadge label="発行済み" tone="success" /> : <StateBadge label="まだ発行していません" />}
        </p>
        {issuedUrl ? (
          <StatusBanner tone="success" heading="リンクを発行しました">
            <p>このリンクはこの画面でしか出ません。コピーして、見る人に渡してください。発行し直すと、前のリンクは開けなくなります。</p>
            <p><input readOnly value={issuedUrl} aria-label="発行したリンク" style={{ width: "100%" }} onFocus={(event) => event.currentTarget.select()} /></p>
            <p><button type="button" className="Admin-secondary" onClick={() => void copy(issuedUrl)}>{copied ? "コピーしました" : "リンクをコピー"}</button></p>
          </StatusBanner>
        ) : null}
        <p className="Admin-note">リンクの先では、日・月・期間を切り替えて見られます。リンクが漏れたときは、発行し直すか止めてください。</p>
        <div className="Admin-row-actions">
          <Form method="post">
            <input type="hidden" name="intent" value="issue" />
            <button type="submit" className="Admin-secondary" disabled={busy}>{data.link.active ? "リンクを発行し直す" : "リンクを発行する"}</button>
          </Form>
          {data.link.active ? (
            <ConfirmAction
              label="リンクを止める"
              heading="リンクを止めますか"
              message="今のリンクは開けなくなります。ブラウザに保存したリンクも使えなくなります。"
              fields={{ intent: "revoke" }}
              disabled={busy}
            />
          ) : null}
        </div>
      </AdminBlock>
      <AdminBlock title="パスワード（任意）" description="リンクを開いた人にパスワードを聞きます。一度入れたブラウザでは、しばらく聞きません。">
        <p>今: {data.link.passwordSet ? <StateBadge label="パスワードあり" tone="success" /> : <StateBadge label="パスワードなし" />}</p>
        <Form method="post" key={data.link.passwordSet ? "set" : "unset"}>
          <input type="hidden" name="intent" value="setPassword" />
          <label>
            新しいパスワード（4〜128 文字）
            <input type="password" name="password" autoComplete="new-password" minLength={4} maxLength={128} required />
          </label>
          <label>
            もう一度
            <input type="password" name="passwordConfirm" autoComplete="new-password" minLength={4} maxLength={128} required />
          </label>
          <p className="Admin-row-actions">
            <button type="submit" className="Admin-secondary" disabled={busy}>パスワードを保存</button>
          </p>
        </Form>
        {data.link.passwordSet ? (
          <ConfirmAction
            label="パスワードを外す"
            heading="パスワードを外しますか"
            message="リンクを知っている人は、パスワードなしで見られるようになります。"
            fields={{ intent: "clearPassword" }}
            disabled={busy}
          />
        ) : null}
      </AdminBlock>
    </>
  );
}
