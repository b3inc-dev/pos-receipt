# Render デプロイ失敗 P3009（精算ロックマイグレーション）の直し方

ログに次が出ているときは、この手順どおりに進めてください。

```text
Error: P3009
The `20260526120000_settlement_operation_lock` migration ... failed
==> Running 'npx prisma migrate deploy && npm run start'
```

---

## 原因（2つ）

1. **DB に「失敗したマイグレーション」の記録が残っている**（最初に SQLite 用 SQL で失敗したときの名残）
2. **Render の Start Command が古いまま**  
   `npx prisma migrate deploy && npm run start` だと、マイグレーションが1回でも失敗するたびに **サーバーが起動せず Deploy failed** になります。

---

## 手順 1: Render のコマンド設定を直す（必須）

対象: **pos-receipt-ciara**（ログに `pos_receipt_db_ciara` と出ているサービス）  
公開用 **pos-receipt** も同じ Start Command なら、同様に直してください。

1. [Render ダッシュボード](https://dashboard.render.com) → 該当 **Web サービス**
2. **Settings** → **Build & Deploy**
3. 次のとおりに設定して **Save Changes**

| 項目 | 設定する値 |
|------|------------|
| **Build Command** | `npm install && npx prisma generate && npm run build` |
| **Pre-Deploy Command** | `npm run render:migrate` |
| **Start Command** | `npm run start` |

**やってはいけない例（Start Command）:**

```bash
npx prisma migrate deploy && npm run start
```

`npm run start` は中身が **`node server.js` だけ** です。マイグレーションは Pre-Deploy の `npm run render:migrate` に任せます。

---

## 手順 2: DB の失敗記録を直す（Shell）

**手順 1 だけでは DB の P3009 は残る**ので、次を実行します。

1. 同じ Web サービス → **Shell**（または **Jobs** → One-Off Job）
2. 次を **そのままコピー＆ペースト**して Enter:

```bash
cd /opt/render/project/src && npm run render:migrate
```

成功するとログに `migrate deploy` や `done (exit 0)` に近い表示が出ます。

### Shell が使えないとき（One-Off Job）

**Jobs** → **Run Job** → Start Command:

```bash
cd /opt/render/project/src && npm run render:migrate
```

---

## 手順 3: 再デプロイ

1. **Manual Deploy** → **Deploy latest commit**
2. **Logs** で次を確認:
   - Pre-Deploy: `[render-migrate]` のログ
   - Start: `[server] http://...`（`node server.js` が起動）
   - **`P3009` が出ない**

---

## 手順 4: 動作確認

デプロイ成功後、ブラウザで（インハウス例）:

- `https://pos-receipt-ciara.onrender.com/api/locations?ping=1` → `ok: true`
- `https://pos-receipt-ciara.onrender.com/api/health/db` → `settlementOperationLockTable: true`（404 の場合はまだ古いビルド）

---

## 手元の `.env.migrate` について

`cp .env.migrate.example .env.migrate` だけでは **中身が空のまま** です。  
次のどちらかを **1行以上** 入れて保存してください。

```env
RENDER_API_KEY=rnd_（Render → Account Settings → API Keys）
```

または

```env
DATABASE_URL=（Postgres → Connect → Internal Database URL）
```

入れたあと、Mac のターミナルで:

```bash
cd /Users/develop/ShopifyApps/pos-receipt
npm run render:one-off-migrate
# または
npm run db:migrate:production
```

---

## 公開用（pos-receipt）も同じエラーなら

Postgres が **別 DB** なら、**pos-receipt** サービスでも手順 2 の Shell を **もう一度** 実行してください。
