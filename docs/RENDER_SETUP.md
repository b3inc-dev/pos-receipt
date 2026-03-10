# Render で POS Receipt を動かす手順

バックエンド（Admin 画面＋API）と、必要なら **PostgreSQL** を Render で用意する手順です。

---

## 前提

- **Render のアカウント**があること（https://dashboard.render.com で無料登録可能）
- **GitHub などに pos-receipt を push 済み**であること（Render は Git からデプロイします）

---

## 1. PostgreSQL を用意する（推奨）

アプリ用の DB を Render 上に作ります。

### 1.1 データベースを作成

1. **Render ダッシュボード**にログイン → **New +** → **PostgreSQL**
2. 次のように入力する：
   - **Name**: 例）`pos-receipt-db`（わかりやすい名前でOK）
   - **Region**: 日本から近い **Singapore** か **Oregon** を選ぶとよい
   - **PostgreSQL Version**: 16 など最新のままでOK
   - **Database**: 空のままでOK（Render が 1 つ作る）
   - **User / Password**: 自動生成される（後から変更も可）
3. **Create Database** を押す
4. 作成後、その DB の画面に入る

### 1.2 接続 URL を控える

- **Connect** や **Connection** のところに **Internal Database URL** がある
- 形式: `postgresql://ユーザー名:パスワード@ホスト名/DB名`
- この URL を **コピー** する（あとで Web サービスの環境変数 `DATABASE_URL` に貼る）
- **Internal** を使うと、同じ Render 内の Web サービスから同じネットワークで接続できて安定する

---

## 2. Web サービス（アプリ本体）を作る

Node アプリ（React Router + API）をデプロイするサービスです。

### 2.1 新規 Web サービスを作成

1. **New +** → **Web Service**
2. **Connect a repository** で、pos-receipt が入っている **GitHub（または GitLab）リポジトリ** を選ぶ
   - まだ連携していなければ **Configure account** で GitHub と接続する
3. リポジトリを選んだら **Connect** を押す

### 2.2 設定を入力

| 項目 | 入力例・説明 |
|------|------------------|
| **Name** | `pos-receipt` など（URL の一部になる: `pos-receipt.onrender.com`） |
| **Region** | 1 で選んだ DB と同じリージョン（例: Singapore）にすると遅延が少ない |
| **Branch** | デプロイしたいブランチ（例: `main`） |
| **Root Directory** | 空のままでOK（リポジトリ直下がルート） |
| **Runtime** | **Node** |
| **Build Command** | `npm install && npx prisma generate && npm run build` |
| **Start Command** | `npm run start` または `npx prisma migrate deploy && npx react-router-serve ./build/server/index.js` |

**Build Command の説明**

- `npm install` … 依存関係のインストール
- `npx prisma generate` … Prisma Client の生成
- `npm run build` … React Router のビルド

**Start Command の説明**

- 本番では起動時にマイグレーションを適用したい場合:  
  `npx prisma migrate deploy && npx react-router-serve ./build/server/index.js`
- マイグレーションは別でやる場合:  
  `npx react-router-serve ./build/server/index.js`（= `npm run start` の中身）

### 2.3 インスタンスタイプ

- **Free** だとスリープするので、常時動かしたい場合は **Starter** などの有料プランを選ぶ
- まずは **Free** で動作確認してから変更してもよい

### 2.4 環境変数を設定する

**Environment** の **Add Environment Variable** で、次の変数を追加する。

| キー | 値 | 説明 |
|------|-----|------|
| **DATABASE_URL** | （1.2 でコピーした Internal Database URL） | PostgreSQL の接続文字列 |
| **SHOPIFY_API_KEY** | パートナーで作ったアプリの **Client ID** | 必須 |
| **SHOPIFY_API_SECRET** | パートナーで作ったアプリの **Client secret** | 必須 |
| **SHOPIFY_APP_URL** | この Web サービスの URL（例: `https://pos-receipt.onrender.com`） | デプロイ後にわかるので、一度デプロイしてから設定・更新してもよい |
| **SCOPES** | `read_orders,read_locations` | 必要に応じて追加 |

**SHOPIFY_APP_URL について**

- 初回はサービス作成後に表示される URL（例: `https://pos-receipt.onrender.com`）を入れる
- パートナーの「アプリの URL」と **同じ** にしておく（認証・リダイレクトで使う）

### 2.5 作成してデプロイ

- **Create Web Service** を押す
- 自動でビルドとデプロイが始まる
- ログでエラーが出たら、**Build Command** や **Start Command**、環境変数を確認する

---

## 3. デプロイ後の確認

1. **Dashboard** の Web サービス一覧で、**pos-receipt** の URL を開く
2. ブラウザで `https://あなたのサービス名.onrender.com` にアクセス
3. Shopify の認証画面や「ログイン」ページが出れば OK
4. パートナーダッシュボードで、アプリの **アプリ URL** を `https://あなたのサービス名.onrender.com` に設定する
5. **shopify.app.toml** の `application_url` と `redirect_urls` も同じ URL にしておく

---

## 4. 自社用・公開用で 2 つに分ける場合

- **公開用** … 1 つの Web サービス（例: `pos-receipt.onrender.com`）＋ 公開用の Postgres（または同じ DB を共有）
- **自社用（POS Receipt - Ciara）** … 別の Web サービス（例: `pos-receipt-ciara.onrender.com`）を **New + → Web Service** で同じリポジトリからもう 1 つ作り、**Branch** や環境変数（`APP_DISTRIBUTION=inhouse` など）だけ変える

DB は 1 つを共有しても、自社用・公開用で別々に作ってもよいです（ショップごとにデータを分けたい場合は別 DB にすると安全）。

---

## 5. よくあるトラブル

| 現象 | 確認すること |
|------|------------------|
| ビルドが失敗する | **Build Command** に `npx prisma generate` と `npm run build` が入っているか。Node のバージョン（**Environment** で `NODE_VERSION=20` など）を指定してみる |
| 起動しない / 500 エラー | **Start Command** が正しいか。**Logs** でエラーメッセージを確認。`DATABASE_URL` が **Internal Database URL** か確認 |
| ログインできない | `SHOPIFY_APP_URL` が Render の URL と一致しているか。パートナーの「アプリの URL」も同じか。`redirect_urls` に `https://あなたのURL/api/auth` などが含まれているか |

---

## まとめ

1. **PostgreSQL** を Render で作成 → **Internal Database URL** をコピー
2. **Web Service** を新規作成 → リポジトリを選択 → **Build / Start** と環境変数（`DATABASE_URL`, `SHOPIFY_*`, `SHOPIFY_APP_URL`）を設定
3. デプロイ後、表示された URL をパートナーと **shopify.app.toml** に設定する

これで Render 上で POS Receipt のバックエンドが動く状態になります。
