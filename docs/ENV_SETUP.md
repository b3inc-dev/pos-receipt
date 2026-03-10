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

## 4. まとめ

1. **`.env` を用意する**（`cp .env.example .env`）
2. **`DATABASE_URL` に PostgreSQL の接続文字列を書く**（ローカル / Render / Supabase のどれか）
3. **`npx prisma generate` と `npx prisma migrate dev` を実行する**
4. 開発時は **`npm run dev`** で起動する（Shopify 用の変数は CLI が補う場合あり）

本番（Render など）では、**.env ではなくサービス側の「Environment」画面で `DATABASE_URL` を設定**してください。
