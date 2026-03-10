# Render 作成後の次のステップ

Web サービスと DB が Render で動いたあとにやることです。

---

## 1. デプロイと URL の確認

1. Render の **pos-receipt** の画面で、デプロイが **Succeeded**（緑）になっているか確認する
2. 画面上部の **URL**（例: `https://pos-receipt.onrender.com`）をクリックして開く
3. 「ログイン」や Shopify の認証画面、またはアプリのページが出れば OK  
   - 502 やエラーなら、**Logs** でエラー内容を確認する

---

## 2. Shopify 側の URL を Render に合わせる

Render の URL を、Shopify アプリの「公式の URL」として登録します。

**ファイルの役割**

| ファイル | 用途 | 今回の Render URL |
|----------|------|-------------------|
| **shopify.app.public.toml** | 公開用（App Store 販売用） | `https://pos-receipt.onrender.com` |
| **shopify.app.toml** | 自社用（POS Receipt - Ciara など） | 自社用 Render の URL（別サービス） |

### 2.1 公開用（今回の Render）の場合

- **shopify.app.public.toml** にすでに `application_url` と `redirect_urls` を `https://pos-receipt.onrender.com` に設定済みです。
- 公開用にデプロイするときは、次のように設定を切り替えてからデプロイします。
  ```bash
  shopify app config use shopify.app.public.toml
  shopify app deploy
  ```

### 2.2 パートナーダッシュボード（公開用アプリ）

1. **パートナーダッシュボード** → **Apps** → **POS Receipt**（公開用）を開く
2. **アプリの URL**（App URL）を **https://pos-receipt.onrender.com** に設定する
3. **リダイレクト URL** や **Allowed redirection URL(s)** があれば、`https://pos-receipt.onrender.com` を登録する

---

## 3. 環境変数 SHOPIFY_APP_URL の確認

Render の **Environment** で、**SHOPIFY_APP_URL** が **Render の URL と同じ** になっているか確認する。

- 例: `SHOPIFY_APP_URL=https://pos-receipt.onrender.com`
- 違っていたら修正し、**Save** のあと **Manual Deploy** で再デプロイする

---

## 4. 開発ストアでアプリを入れて動作確認

1. **Shopify CLI** で開発ストアにログインしているか確認  
   `cd /Users/develop/ShopifyApps/pos-receipt` のあと、必要なら `npm run dev` でストアを選ぶ
2. **パートナー** → **開発用ストア** を開く
3. **アプリ** から **POS Receipt** をインストール（または「テスト」）
4. **管理画面** でアプリを開き、ログインや画面表示ができるか確認する
5. **POS** を起動し、POS Receipt のタイル（取引検索など）が表示され、API が動くか確認する

---

## 5. POS 拡張のデプロイ（まだなら）

POS のタイルやモーダルを本番でも使うには、拡張を Shopify にデプロイします。

```bash
cd /Users/develop/ShopifyApps/pos-receipt
npm run deploy
```

- 公開用にデプロイする場合は、先に `shopify app config use shopify.app.public.toml` を実行してから `npm run deploy` してください
- デプロイ後、POS アプリ一覧に **POS Receipt** が現れ、タイルをタップできるようになります

---

## 6. 今後の開発の進め方

- **コードを直したら**  
  GitHub に push すると、Render が自動で再デプロイします（Auto-Deploy がオンの場合）
- **POS や Admin の変更**  
  必要に応じて `npm run deploy` で再度デプロイ
- **DB のスキーマ変更**  
  `prisma migrate dev` でマイグレーションを作成し、変更を push。Render の **Start Command** に `npx prisma migrate deploy` が入っていれば、デプロイ時に自動で適用されます

---

## チェックリスト

| # | やること | 状態 |
|---|----------|------|
| 1 | Render のデプロイが成功し、URL で画面が開ける |  |
| 2 | shopify.app.public.toml（公開用）の application_url / redirect_urls を Render の URL にした |  |
| 3 | パートナーの「アプリの URL」を Render の URL にした |  |
| 4 | Render の SHOPIFY_APP_URL が Render の URL と同じ |  |
| 5 | 開発ストアでアプリをインストールし、管理画面が開ける |  |
| 6 | （必要なら）npm run deploy で POS 拡張をデプロイした |  |
| 7 | POS でタイルをタップし、取引検索などが動く |  |

ここまでできたら、要件書の **Prompt 4（特殊返金・商品券調整）** や **精算・領収書** などの実装に進めます。
