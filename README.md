# Shopify App Template - Extension only

This is a template for building an [extension-only Shopify app](https://shopify.dev/docs/apps/build/app-extensions/build-extension-only-app). It contains the basics for building a Shopify app that uses only app extensions.

This template doesn't include a server or the ability to embed a page in the Shopify Admin. If you want either of these capabilities, choose the [Remix app template](https://github.com/Shopify/shopify-app-template-remix) instead.

Whether you choose to use this template or another one, you can use your preferred package manager and the Shopify CLI with [these steps](#installing-the-template).

## Benefits

Shopify apps are built on a variety of Shopify tools to create a great merchant experience. The [create an app](https://shopify.dev/docs/apps/getting-started/create) tutorial in our developer documentation will guide you through creating a Shopify app.

This app template does little more than install the CLI and scaffold a repository.

## Getting started

### Requirements

1. You must [download and install Node.js](https://nodejs.org/en/download/) if you don't already have it.
1. You must [create a Shopify partner account](https://partners.shopify.com/signup) if you don’t have one.
1. You must create a store for testing if you don't have one, either a [development store](https://help.shopify.com/en/partners/dashboard/development-stores#create-a-development-store) or a [Shopify Plus sandbox store](https://help.shopify.com/en/partners/dashboard/managing-stores/plus-sandbox-store).

### Installing the template

This template can be installed using your preferred package manager:

Using yarn:

```shell
yarn create @shopify/app
```

Using npm:

```shell
npm init @shopify/app@latest
```

Using pnpm:

```shell
pnpm create @shopify/app@latest
```

This will clone the template and install the required dependencies.

#### Local Development

[The Shopify CLI](https://shopify.dev/docs/apps/tools/cli) connects to an app in your Partners dashboard. It provides environment variables and runs commands in parallel.

You can develop locally using your preferred package manager. Run one of the following commands from the root of your app.

Using yarn:

```shell
yarn dev
```

Using npm:

```shell
npm run dev
```

Using pnpm:

```shell
pnpm run dev
```

Open the URL generated in your console. Once you grant permission to the app, you can start development (such as generating extensions).

## 会員証（LIFF）機能

LINE LIFF を使った会員証表示機能です。LINE リッチメニューから LIFF を起動し、Shopify ログイン不要で会員バーコードを表示します。

**カスタムアプリのみ有効**: この機能は `APP_DISTRIBUTION=inhouse` のときのみ有効です。公開アプリ（`shopify.app.public.toml` でデプロイ）では管理画面のメニューに表示されず、会員証 URL にアクセスしても 404 となります。

### 環境変数

| 変数名 | 説明 | 必須 |
|--------|------|------|
| `LINE_CHANNEL_ID` | LINE ログイン / LIFF 用チャネルの Channel ID | 会員証利用時 |
| `LINE_CHANNEL_SECRET` | 上記チャネルの Channel Secret（id_token 検証用） | 会員証利用時 |
| `LIFF_ID` | LIFF アプリの LIFF ID | 会員証利用時 |
| `SHOPIFY_APP_URL` | アプリの公開 URL（例: `https://xxx.onrender.com`）。App Proxy と API のベース URL に使用 | 常に |

※ 既存の Shopify 用環境変数（`SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` 等）も必要です。

### App Proxy の設定手順

1. **shopify.app.toml で設定済み**
   - `[app_proxy]` で `url = "/apps/member-card"`, `prefix = "apps"`, `subpath = "member-card"` を指定済みです。
2. **スコープ**
   - `write_app_proxy` と `read_customers` を `[access_scopes]` に含めてください（要再インストールで反映）。
3. **デプロイ後**
   - ストア側の会員証の公開 URL は `https://{あなたのショップ}.myshopify.com/apps/member-card` になります。
4. **変更したい場合**
   - prefix / subpath はインストール後にストアごとに「設定 > アプリと販売チャネル > 対象アプリ > App proxy > URL をカスタマイズ」で変更できます。toml の変更は新規インストール時のみ反映されます。

### LIFF 側の設定手順

1. [LINE Developers Console](https://developers.line.biz/) で LIFF アプリを作成し、LIFF ID を取得する。
2. **Endpoint URL** に、上記の会員証の公開 URL を設定する。
   - 例: `https://{あなたのショップ}.myshopify.com/apps/member-card`
3. 同じ LINE チャネルで LINE Login を有効にし、LIFF の「スコープ」で必要な項目（プロフィール等）を設定する。
4. 取得した **LIFF ID** を環境変数 `LIFF_ID` に設定する。
5. 管理画面の「会員証（LIFF）」ページで、設定状態（LIFF ID・App Proxy パス・アプリ URL）を確認できる。

### 前提となる Shopify データ

- **顧客 metafield（会員番号）**: `membership.id`（namespace: `membership`, key: `id`, 型: single_line_text_field）
- **顧客 metafield（LINE 連携）**: `socialplus.line`（namespace: `socialplus`, key: `line`, 型: single_line_text_field）  
  CRM PLUS on LINE などで LINE 連携済みの顧客に LINE User ID が保存されていること。

### ローカル開発方法

1. 上記の環境変数を `.env` または `shopify app dev` に渡す方法で設定する。
2. ターミナルで `npm run dev`（または `shopify app dev`）を実行する。
3. 開発用トンネル URL が表示される。App Proxy の URL は CLI が自動で開発ストアに反映する。
4. ブラウザで `https://{開発用ストア}.myshopify.com/apps/member-card` を開き、LIFF の動作を確認する（LINE ログインが必要）。

### デプロイ方法

1. Render 等にデプロイする場合、そのホストの URL を `SHOPIFY_APP_URL` に設定する。
2. `shopify app deploy` でアプリをデプロイする（App Proxy の URL はアプリの URL に自動で紐づく）。
3. 本番ストアでアプリをインストール（または更新）し、会員証の公開 URL が `https://{ストア}.myshopify.com/apps/member-card` になることを確認する。
4. LINE の LIFF の Endpoint URL を、本番ストアの会員証 URL に設定する。

---

## Developer resources

- [Introduction to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [App extensions](https://shopify.dev/docs/apps/build/app-extensions)
- [Extension only apps](https://shopify.dev/docs/apps/build/app-extensions/build-extension-only-app)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
