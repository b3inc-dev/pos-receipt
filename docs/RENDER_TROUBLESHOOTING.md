# Render で「Instance failed / Exited with status 1」が出るときの対処

「Exited with status 1 while running your code」は **アプリのプロセスが起動直後または最初のリクエストで落ちている** 状態です。  
以下を順に確認してください。

---

## 「The table `public.Session` does not exist」が出る場合

**原因**: `prisma/migrations` にマイグレーションファイルがなく、本番 DB にテーブルが作られていない。

**対処**:
1. リポジトリに **初期マイグレーション** が含まれているか確認する（`prisma/migrations/20260310112900_init/migration.sql` など）。
2. 含まれていなければ、このドキュメントの「2. Build Command」「3. Start Command」を設定したうえで、**Manual Deploy** を実行する。  
   （初回デプロイで `prisma migrate deploy` がマイグレーションを適用し、`Session` などのテーブルが作成される。）
3. まだエラーになる場合は、**Logs** の Run で `No migration found` が出ていないか確認する。出ている場合は、マイグレーションを追加してコミット・プッシュし、再デプロイする。

---

## 1. 本当のエラー内容を確認する（必須）

**Events** ではなく **Logs** を見ます。

1. Render ダッシュボードで **pos-receipt** の Web サービスを開く
2. 左メニューまたはタブで **「Logs」** を開く
3. **直近のデプロイの「Run」ログ**（起動後の標準出力・標準エラー）をスクロールする
4. `Error:` や `PrismaClientInitializationError`、`ECONNREFUSED`、`relation "Session" does not exist` などの **メッセージ** を探す

ここに表示されているエラーが原因です。メッセージを控えてから下の項目を確認してください。

---

## 2. Build Command の確認

**Build Command** に **Prisma の生成** が含まれていないと、本番で Prisma が動かず status 1 で落ちます。

### 正しい例

```bash
npm install && npx prisma generate && npm run build
```

- `npx prisma generate` … 必須。これがないと `@prisma/client` がスキーマに合わせて生成されず、起動時にエラーになります。
- `npm run build` … React Router のビルド（`./build/server/index.js` を作る）

**設定場所**: サービス → **Settings** → **Build & Deploy** → **Build Command**

---

## 3. Start Command の確認

起動コマンドが違うと、サーバーが立ち上がらなかったり、DB 未適用のまま動いて最初のリクエストで落ちたりします。

### 推奨（マイグレーションを起動時に実行）

```bash
npx prisma migrate deploy && npx react-router-serve ./build/server/index.js
```

- `prisma migrate deploy` … 本番 DB にマイグレーションを適用（`Session` などのテーブルを作る）
- これをやっていないと、最初のリクエストで「relation "Session" does not exist」などで落ちることがあります。

### 別案（マイグレーションは手動でやる場合）

```bash
npx react-router-serve ./build/server/index.js
```

この場合は、**初回だけ** Render の **Shell** やローカルから `npx prisma migrate deploy` を実行してテーブルを作っておく必要があります。

**設定場所**: サービス → **Settings** → **Build & Deploy** → **Start Command**

---

## 4. 環境変数の確認

次の変数が **Environment** に設定されていないと、起動時や初回リクエストで落ちることがあります。

| 変数 | 説明 |
|------|------|
| **DATABASE_URL** | Render の PostgreSQL の **Internal Database URL**（必須） |
| **SHOPIFY_API_KEY** | パートナーアプリの Client ID |
| **SHOPIFY_API_SECRET** | パートナーアプリの Client secret |
| **SHOPIFY_APP_URL** | このサービスの URL（例: `https://pos-receipt.onrender.com`） |
| **SCOPES** | 例: `read_orders,read_locations` |

- **DATABASE_URL** が無い／間違っている  
  → Prisma が DB に接続できず、`PrismaClientInitializationError` や接続エラーで status 1 になります。
- **SHOPIFY_APP_URL** が違う  
  → 認証まわりで不具合が出ることがあります。Render のサービス URL と完全に一致させてください。

**設定場所**: サービス → **Environment** → **Add Environment Variable**

---

## 5. チェックリスト

| # | 確認内容 |
|---|----------|
| 1 | **Logs** の Run ログで、エラーメッセージを確認した |
| 2 | Build Command に `npx prisma generate` が入っている |
| 3 | Start Command に `npx prisma migrate deploy &&` を含めている（または別途マイグレーション済み） |
| 4 | **DATABASE_URL** に Render の **Internal Database URL** を設定した |
| 5 | **SHOPIFY_API_KEY** / **SHOPIFY_API_SECRET** / **SHOPIFY_APP_URL** を設定した |

---

## 6. 修正後のやり直し

1. 上記を修正したら **Save Changes**
2. **Manual Deploy** → **Deploy latest commit** で再デプロイ
3. 再度 **Logs** の Run を確認し、まだ status 1 なら **表示されているエラー文** を手がかりに原因を特定する

ログに表示されているエラー文（そのままコピー）があれば、それに合わせてさらに原因を絞り込めます。
