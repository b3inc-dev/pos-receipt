# POS タイル「Load failed」の要因と対処

タイルがすべて「Load failed」で情報が表示されない場合の主な要因と確認手順です。

---

## 0. POS Stock と POS Receipt の違い（ロケーション読み込み）

| 項目 | POS Stock（stock-transfer-pos） | POS Receipt（変更前） |
|------|--------------------------------|------------------------|
| **ロケーション取得** | **Shopify 内蔵 API** `fetch("shopify:admin/api/graphql.json")` で GraphQL を実行。POS が認証を処理するため**自社バックエンド不要**。 | 自社バックエンド `GET /api/locations` を Bearer トークン付きで呼んでいた。 |
| **結果** | タイル／モーダルはバックエンドが落ちていてもロケーション一覧が表示される。 | バックエンドに届かない・401 だと「ロケーションの取得に失敗しました」や Load failed になる。 |

**今回の対応**: POS Receipt でも **まず Shopify 内蔵 GraphQL**（`extensions/common/shopifyAdminGraphql.js`）でロケーション一覧を取得するように変更。そのうえでバックエンドから printMode 等を取得してマージし、バックエンド失敗時はデフォルトのまま表示する。

- 追加: `extensions/common/shopifyAdminGraphql.js`（`adminGraphql`, `getLocationsFromShopify`）
- 変更: `SettlementModal.jsx` の `loadLocations` で `getLocationsFromShopify()` を先に実行し、その後 `getLocations()` でマージ。

---

## 1. 主な要因（優先度順）

### ① 開発モード時のバックエンド URL のずれ（最も多い）

**状況**: `shopify app dev` で公開アプリを開いているとき、POS 拡張は **ビルド時に埋め込まれた本番 URL**（例: `https://pos-receipt.onrender.com`）に API を投げます。一方、実際に動いているのは **トンネル（ngrok 等）のローカルサーバー** です。

**結果**:
- トンネル経由で開いた POS のセッショントークンは「dev 用」のコンテキスト
- リクエストだけが本番サーバーに行く → 本番側でセッション不一致や 401
- あるいは本番サーバーに接続できない → ネットエラー
- タイルやモーダルの「Load failed」として表示される

**対処**: 拡張側で「今のオリジンが dev 系なら、そのオリジンに API を飛ばす」ようにする（下記「2. 修正内容」参照）。

---

### ② セッショントークンとバックエンドのアプリが一致していない

**状況**: 開発用ストアにインストールしているアプリ（例: 公開用 POS Receipt）と、API を呼んでいるバックエンドの `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` が別アプリのものになっている。

**結果**: バックエンドが Bearer トークンを検証できず 401 → 「Load failed」。

**確認**:
- 開発で使っている toml（`shopify.app.public.toml` か `shopify.app.toml`）の `client_id` と、実際に API を処理しているサーバー（Render やローカル .env）の `SHOPIFY_API_KEY` が同じか確認する。
- 自社用で dev している場合は、その自社用アプリの Client ID/Secret が .env に入っているか確認する。

---

### ③ 拡張の読み込み・実行エラー（タイル表示時点で失敗）

**状況**: タイル用 JS の読み込み失敗、またはエントリ実行時の例外（preact の render 失敗、`shopify` / `s-tile` 未定義など）。

**結果**: 各タイルが「Load failed」と表示される。

**確認**:
- `shopify app dev` のターミナルに拡張ビルドエラーが出ていないか確認する。
- 過去に「Tile.jsx not found」等が出た場合は、`.shopify/dev-bundle/` と `extensions/pos-smart-grid/dist/` を削除してから `shopify app dev` をやり直す（`posreceipt_requirements_spec.md` §30.3 参照）。

---

### ④ ネットワーク・CORS

**状況**: 実機の POS からバックエンドへ届かない、または CORS でブロックされている。

**結果**: fetch が失敗し「Load failed」になる。

**確認**:
- 同じネットワークで、ブラウザからバックエンドの URL にアクセスできるか確認する。
- バックエンドは `authenticate.pos(request)` 経由で CORS を返す想定。別オリジンから直接呼ぶカスタム API を追加している場合は、そのルートでも CORS ヘッダーが出ているか確認する。

---

## 2. 修正内容（開発モードでトンネルを向くようにする）

`extensions/common/appUrl.js` の `getAppUrl()` で、「今のオリジンが dev 系（トンネル・localhost）ならそのオリジンを使う」ようにします。これで `shopify app dev` 時は同じトンネル上のバックエンドに API が飛び、タイル／モーダルの「Load failed」が解消しやすくなります。

- 変更ファイル: `extensions/common/appUrl.js`
- 変更内容: 実行環境で `window.location.origin` を参照し、その origin が localhost / 127.0.0.1 / ngrok 等なら `getAppUrl()` がその origin を返すようにする。

**実装**: `extensions/common/appUrl.js` の `getAppUrl()` で、`globalThis.window?.location?.origin` が取れる場合に、その origin が localhost / ngrok 等ならそのまま返すようにしてあります。`shopify app dev` で拡張がトンネルから配信されると、API も同じトンネルに飛ぶため、セッションのずれが起きにくくなります。

**注意**: POS の実行環境によっては `window` が存在せず、この判定が使われない場合があります。そのときは従来どおり本番 URL に飛ぶため、② の「アプリ一致」を確認してください。

---

## 3. 確認チェックリスト

- [ ] `shopify app dev` を実行した toml（public / inhouse）と、バックエンドの `SHOPIFY_API_KEY` が同じアプリを指している
- [ ] 拡張を修正したあと、ターミナルで拡張の再ビルドが完了している（エラーなし）
- [ ] POS は dev 用 QR/URL から開き、同じ開発用ストアでログインしている
- [ ] 必要に応じて `.shopify/dev-bundle/` と `extensions/pos-smart-grid/dist/` を削除してから `shopify app dev` を再実行した
- [ ] `appUrl.js` で開発時はトンネル origin を使うように修正済みか

---

---

## 「Load failed」と「履歴がない」の違い

**「Load failed」は履歴の有無ではありません。** 読み込み（API 呼び出し）が失敗したときの**エラー表示**です。

| 表示 | 意味 |
|------|------|
| **Load failed** | バックエンドへのリクエストが失敗した（ネットワーク・認証・サーバーエラー等）。データを取得できなかった。 |
| **精算履歴がありません。** / **発行履歴がありません。** | API は成功したが、該当する履歴が 0 件だった（空の一覧）。 |

そのため、「ボタンは出るが情報が Load failed」のときは、**一覧や詳細を取得する API が失敗している**と考えてください。  
対策として、共通で「Load failed」等の英語メッセージを日本語に変換する `extensions/common/errorMessage.js`（`toUserMessage`）を追加し、各 API クライアントとモーダルの catch で使用するようにしています。表示が「読み込みに失敗しました。接続先と認証を確認してください。」等に変わり、原因の切り分けがしやすくなります。

---

*このドキュメントは POS タイル「Load failed」の要因整理と、開発モード時の URL ずれ対策用です。*
