# 環境変数（.env）の設定

アプリと DB を動かすために、プロジェクト直下に **`.env`** を作成し、必要な変数を設定します。

---

## 1. .env ファイルを作る

```bash
cd /Users/develop/ShopifyApps/pos-receipt
cp .env.example .env
```

`.env` は Git に含めません（.gitignore 済み）。本番では Render 等の「Environment」で設定します。

---

## 2. DATABASE_URL の設定

Prisma が使う **PostgreSQL** の接続文字列です。

### 形式

```
DATABASE_URL="postgresql://ユーザー名:パスワード@ホスト:ポート/DB名?schema=public"
```

### パターン別

| 環境 | やり方 |
|------|--------|
| **ローカルに PostgreSQL がある** | ユーザー・パスワード・ポート（通常 5432）・DB 名を入れる。DB はあらかじめ作成しておく。 |
| **Docker で PostgreSQL を立てる** | 例: `postgresql://postgres:postgres@localhost:5432/pos_receipt?schema=public`（コンテナのユーザー/パス/ポートに合わせる）。 |
| **Render の Postgres** | Render ダッシュボード → 該当 Postgres サービス → **Connect** → **Internal Database URL** をコピーして `DATABASE_URL` に貼る。 |
| **Supabase** | プロジェクト → Settings → Database → **Connection string** の **URI** をコピー。`postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres` のような形式。 |

### ローカル用の例（そのままでは動きません・値を差し替えてください）

```env
# ローカル Postgres（DB 名 pos_receipt は事前に作成）
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/pos_receipt?schema=public"
```

### 初回だけ DB を作る（ローカル Postgres の場合）

```bash
# psql で入る例（環境に合わせてユーザー名・ホストを変える）
createdb -U postgres pos_receipt
```

その後、`.env` の `DATABASE_URL` を上記形式で設定し、以下を実行します。

```bash
npx prisma generate
npx prisma migrate dev --name init_mvp
```

---

## 3. Shopify 用の変数（開発時）

`npm run dev`（`shopify app dev`）で開発するときは、**Shopify CLI が .env に `SHOPIFY_API_KEY` などを自動で書き足す**ことがあります。  
パートナーでアプリを作成済みなら、手動で設定する場合は次のとおりです。

- **SHOPIFY_API_KEY** … アプリの Client ID（パートナー → アプリ → クライアント ID）
- **SHOPIFY_API_SECRET** … アプリの Client secret
- **SCOPES** … 例: `read_orders,read_locations`（必要に応じて追加）

開発時は `shopify app dev` 実行時に CLI がストアを選ばせ、トンネル URL などを設定してくれるので、**最低限 `DATABASE_URL` が正しければ** Prisma は動きます。

---

## 4. 本番（Render）で自社用と公開用を分ける場合

**自社用**（POS Receipt - Ciara）と**公開用**（POS Receipt）で別々の Render Web サービスを用意している場合、それぞれで次のように環境変数を分けます。

| 変数 | 自社用（pos-receipt-ciara.onrender.com） | 公開用（pos-receipt.onrender.com） |
|------|------------------------------------------|-------------------------------------|
| **SHOPIFY_API_KEY** | 自社用アプリの Client ID（`ec5374155070d767e71bbe5c258160e2`） | 公開用アプリの Client ID |
| **SHOPIFY_API_SECRET** | 自社用アプリの Client secret | 公開用アプリの Client secret |
| **SHOPIFY_APP_URL** | **`https://pos-receipt-ciara.onrender.com`**（必須・未設定だと管理画面が真っ白になる） | `https://pos-receipt.onrender.com` |
| **APP_DISTRIBUTION** | `inhouse`（必須） | 未設定 または `public` |
| **DATABASE_URL** | 自社用の DB または共有 DB の URL | 公開用の DB または共有 DB の URL |

- 自社用の Render では、**SHOPIFY_API_KEY** と **SHOPIFY_API_SECRET** をパートナー上の「POS Receipt - Ciara」アプリの値にしてください。公開用の値のままにすると認証で失敗します。
- 詳細は `docs/DEPLOY_PUBLIC_AND_INHOUSE.md` を参照してください。

---

## 5. まとめ

1. **`.env` を用意する**（`cp .env.example .env`）
2. **`DATABASE_URL` に PostgreSQL の接続文字列を書く**（ローカル / Render / Supabase のどれか）
3. **`npx prisma generate` と `npx prisma migrate dev` を実行する**
4. 開発時は **`npm run dev`** で起動する（Shopify 用の変数は CLI が補う場合あり）

本番（Render など）では、**.env ではなくサービス側の「Environment」画面で上記変数を設定**してください。
