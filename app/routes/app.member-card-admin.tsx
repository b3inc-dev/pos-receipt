/**
 * 会員証の管理画面。
 * カスタムアプリ（APP_DISTRIBUTION=inhouse）でのみ表示。公開アプリでは /app へリダイレクト。
 * 店の人には「使えるか」「リンク」「見本」だけを出し、LIFF・環境変数などは「詳しい設定」に畳む（T 11/24）。
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, redirect } from "react-router";
import { useState } from "react";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { PolarisPageWrapper } from "../components/PolarisPageWrapper";
import { MemberBarcode } from "../components/MemberBarcode";
import { isInhouseMode } from "../utils/planFeatures.server";
import { SystemPageNav } from "../components/SystemPageNav";
import { fieldLabel, readLineIdFields } from "../utils/memberCardLineFields";
import { AdminBlock, AdminIntro, StateBadge } from "../components/admin-ui";
import { StoreBody } from "../components/StoreBody";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  if (!isInhouseMode()) {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const q = shop ? `?shop=${encodeURIComponent(shop)}` : "";
    return redirect(`/app${q}`);
  }
  const shop = new URL(request.url).searchParams.get("shop") ?? "";
  const liffIdSet = Boolean(process.env.LIFF_ID?.trim());
  const apiBaseSet = Boolean(process.env.SHOPIFY_APP_URL?.trim());
  const lineChannelSet =
    Boolean(process.env.LINE_CHANNEL_ID?.trim()) &&
    Boolean(process.env.LINE_CHANNEL_SECRET?.trim());

  const proxyPath = "apps/member-card";
  const proxyUrl = shop ? `https://${shop}/${proxyPath}` : "";

  const lineIdFields = readLineIdFields().map(fieldLabel);

  return {
    shop,
    lineIdFields,
    liffIdSet,
    apiBaseSet,
    lineChannelSet,
    proxyPath,
    proxyUrl,
  };
}

export default function MemberCardAdminPage() {
  const data = useLoaderData<typeof loader>();
  const ready = data.liffIdSet && data.lineChannelSet && data.apiBaseSet;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.proxyUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <PolarisPageWrapper>
      <Page title="会員証" backAction={{ content: "ホーム", url: "/app" }}>
        <SystemPageNav memberCardEnabled={true} />
        <StoreBody>
          <AdminIntro>
            <p>お客さまが LINE のメニューから会員証を開くと、会員番号のバーコードが出ます。お店ではそのバーコードを読み取ります。</p>
          </AdminIntro>
          <AdminBlock title="今の状態">
            <p>
              {ready ? <StateBadge label="使えます" tone="success" /> : <StateBadge label="まだ使えません" tone="warning" />}
            </p>
            <p className="Admin-note">
              {ready
                ? "LINE とのつなぎ込みは済んでいます。"
                : "LINE とのつなぎ込みがまだ済んでいません。下の「詳しい設定」を開発の担当の人に見てもらってください。"}
            </p>
          </AdminBlock>
          <AdminBlock title="会員証のリンク" description="LINE のメニューに、このリンクを置きます。">
            {data.proxyUrl ? (
              <>
                <p><input readOnly value={data.proxyUrl} aria-label="会員証のリンク" style={{ width: "100%" }} onFocus={(event) => event.currentTarget.select()} /></p>
                <p><button type="button" className="Admin-secondary" onClick={() => void copy()}>{copied ? "コピーしました" : "リンクをコピー"}</button></p>
              </>
            ) : (
              <p className="Admin-note">ショップが分からないため、リンクを出せません。Shopify の管理画面から開き直してください。</p>
            )}
            <p className="Admin-note">会員証が出るのは、LINE とつながっていて、会員番号が入っているお客さまです。</p>
          </AdminBlock>
          <AdminBlock title="バーコードの見本" description="会員証にはこの形で会員番号が出ます。">
            <div style={{ textAlign: "center", padding: "16px 0" }}>
              <MemberBarcode value="12345678" />
            </div>
          </AdminBlock>
          <AdminBlock title="詳しい設定" description="開発の担当の人向けです。ふだんは開かなくてかまいません。">
            <details>
              <summary>開く</summary>
              <ul>
                <li>LIFF ID: {data.liffIdSet ? "設定済み" : "未設定"}</li>
                <li>LINE チャネル（ID と Secret）: {data.lineChannelSet ? "設定済み" : "未設定"}</li>
                <li>アプリの URL（SHOPIFY_APP_URL）: {data.apiBaseSet ? "設定済み" : "未設定"}</li>
                <li>App Proxy のパス: {data.proxyPath}</li>
                <li>LINE ユーザー ID を読む項目（この順）: {data.lineIdFields.join(" → ")}</li>
              </ul>
              <p className="Admin-note">
                LINE Developers の LIFF アプリの「Endpoint URL」に、上の会員証のリンクを入れます。読む項目の順番は環境変数 MEMBER_CARD_LINE_ID_METAFIELDS で変えられます。会員番号は membership.id から読みます。
              </p>
            </details>
          </AdminBlock>
        </StoreBody>
      </Page>
    </PolarisPageWrapper>
  );
}
